import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const OUT = path.join(HERE, "worker");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"]);

async function walk(dir, base = dir) {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...(await walk(full, base)));
    else entries.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return entries;
}

const files = (await walk(DIST))
  .filter((file) => !file.split("/").some((segment) => segment.startsWith(".")))
  .sort();
const dirs = files
  .filter((file) => file.endsWith("index.html") && file !== "index.html")
  .map((file) => "/" + file.split("/").slice(0, -1).join("/"));
const payload = {};
for (const relativePath of files) {
  const extension = path.extname(relativePath).toLowerCase();
  const buffer = await readFile(path.join(DIST, relativePath));
  const binary = BINARY_EXT.has(extension);
  payload["/" + relativePath] = {
    t: MIME[extension] ?? "application/octet-stream",
    ...(binary ? { bin: 1 } : {}),
    b: binary ? buffer.toString("base64") : buffer.toString("utf8"),
  };
}

const raw = Buffer.from(JSON.stringify(payload), "utf8");
const gz = gzipSync(raw, { level: 9 });
const b64 = gz.toString("base64");

const BOILER = `const B64="@@PAYLOAD@@";
let CACHE=null;
async function files(){
  if(CACHE)return CACHE;
  const bytes=Uint8Array.from(atob(B64),character=>character.charCodeAt(0));
  const stream=new DecompressionStream("gzip");
  const response=new Response(new Blob([bytes]).stream().pipeThrough(stream));
  CACHE=JSON.parse(await response.text());
  return CACHE;
}
const DIRS=@@DIRS@@;
const CSP="default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;object-src 'none';base-uri 'none';frame-ancestors 'none'";
const NOSTORE={"cache-control":"no-store","x-content-type-options":"nosniff"};
function find(entries,pathname){
  if(entries[pathname])return pathname;
  const base=pathname.endsWith("/")?pathname:pathname+"/";
  const index=base+"index.html";
  return entries[index]?index:null;
}
function json(value,status){return new Response(JSON.stringify(value),{status:status||200,headers:Object.assign({"content-type":"application/json; charset=utf-8"},NOSTORE)})}
export default{fetch:async(request,env)=>{
  const url=new URL(request.url);
  if(url.pathname==="/api/provider-config"){
    if(request.method!=="GET")return new Response("Method Not Allowed",{status:405,headers:{allow:"GET"}});
    const cfgKey=(env&&typeof env.PROVIDER_KEY==="string"?env.PROVIDER_KEY:"").trim();
    if(cfgKey.length===0)return json({ok:false,err:"not-configured"},404);
    const gate=(env&&typeof env.PROVIDER_CONFIG_TOKEN==="string"?env.PROVIDER_CONFIG_TOKEN:"").trim();
    if(gate.length!==0&&(request.headers.get("x-provider-token")||"")!==gate)return json({ok:false,err:"forbidden"},403);
    const baseUrl=(env&&typeof env.PROVIDER_BASE_URL==="string"?env.PROVIDER_BASE_URL:"").trim();
    const model=(env&&typeof env.PROVIDER_MODEL==="string"?env.PROVIDER_MODEL:"").trim();
    const styleRaw=(env&&typeof env.PROVIDER_ENDPOINT_STYLE==="string"?env.PROVIDER_ENDPOINT_STYLE:"").trim().toLowerCase();
    const style=(styleRaw==="decisions"||styleRaw==="systemone")?styleRaw:"auto";
    const ttlRaw=Number(env&&env.PROVIDER_CONFIG_TTL_SECONDS);
    const ttl=Number.isFinite(ttlRaw)?Math.min(3600,Math.max(60,Math.trunc(ttlRaw))):600;
    return json({ok:true,v:1,baseUrl:baseUrl,model:model,endpointStyle:style,key:cfgKey,ttlSeconds:ttl},200);
  }
  if(url.pathname.indexOf("/api/")===0)return json({ok:false,err:"not-found"},404);
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response("Method Not Allowed",{status:405,headers:{allow:"GET, HEAD"}});
  const pathname=decodeURIComponent(url.pathname);
  if(DIRS.includes(pathname))return Response.redirect(new URL(pathname+"/"+url.search,url).href,308);
  const entries=await files();
  const key=find(entries,pathname);
  if(!key)return new Response("Not Found\\n",{status:404,headers:{"content-type":"text/plain; charset=utf-8"}});
  const file=entries[key],etag='"'+key+'"';
  if(request.headers.get("if-none-match")===etag)return new Response(null,{status:304,headers:{etag:etag}});
  const body=file.bin?Uint8Array.from(atob(file.b),character=>character.charCodeAt(0)):file.b;
  return new Response(body,{status:200,headers:{
    "content-type":file.t,etag:etag,
    "cache-control":"public, max-age=300, must-revalidate",
    "x-content-type-options":"nosniff",
    "referrer-policy":"strict-origin-when-cross-origin",
    "content-security-policy":CSP}});
}};`;

const script = BOILER.replace("@@PAYLOAD@@", b64).replace("@@DIRS@@", JSON.stringify(dirs));

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "bundle.js"), script);
await writeFile(path.join(OUT, "payload.b64"), b64);
console.log(`dirs (308 redirect): ${JSON.stringify(dirs)}`);
console.log(`raw JSON      : ${(raw.length / 1024).toFixed(1)} KB`);
console.log(`gzip          : ${(gz.length / 1024).toFixed(1)} KB`);
console.log(`base64 payload: ${(b64.length / 1024).toFixed(1)} KB (${b64.length} chars)`);
console.log(`worker script : ${(script.length / 1024).toFixed(1)} KB`);
console.log(`files         : ${files.length} -> ${files.join(", ")}`);
