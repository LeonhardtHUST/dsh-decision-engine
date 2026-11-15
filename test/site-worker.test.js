import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";

const bundlerUrl = new URL("../site/make-bundle.mjs", import.meta.url);

async function workerFixture() {
  const source = await readFile(bundlerUrl, "utf8");
  const match = /const BOILER = `([\s\S]*?)`;/u.exec(source);
  assert.ok(match !== null);
  const template = runInNewContext("`" + match[1] + "`");
  const payload = {
    "/index.html": { t: "text/html; charset=utf-8", b: "<h1>Fixture</h1>" },
    "/en/index.html": { t: "text/html; charset=utf-8", b: "<h1>English</h1>" },
    "/assets/test.png": { t: "image/png", bin: 1, b: Buffer.from([137, 80, 78, 71]).toString("base64") },
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64");
  const script = template.replace("@@PAYLOAD@@", compressed).replace("@@DIRS@@", '["/en"]');
  const module = await import(`data:text/javascript;base64,${Buffer.from(script).toString("base64")}`);
  return module.default;
}

test("Worker 不再采集匿名心跳、生成日报或调用外网", async (context) => {
  const worker = await workerFixture();
  const requests = [];
  context.mock.method(globalThis, "fetch", async (...args) => {
    requests.push(args);
    throw new Error("Unexpected outgoing request");
  });
  const forbiddenEnv = new Proxy({}, { get() { throw new Error("Removed route accessed environment"); } });
  assert.equal(Object.hasOwn(worker, "scheduled"), false);
  for (const path of ["/api/e", "/api/digest"]) {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(`https://site.invalid${path}`, { method }), forbiddenEnv);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { ok: false, err: "not-found" });
    }
  }
  assert.deepEqual(requests, []);
});

test("Worker 保留静态页面、目录重定向、缓存与二进制图片", async () => {
  const worker = await workerFixture();
  const home = await worker.fetch(new Request("https://site.invalid/"));
  assert.equal(home.status, 200);
  assert.equal(await home.text(), "<h1>Fixture</h1>");
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);
  const redirect = await worker.fetch(new Request("https://site.invalid/en?fixture=1"));
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://site.invalid/en/?fixture=1");
  const cached = await worker.fetch(new Request("https://site.invalid/", { headers: { "if-none-match": home.headers.get("etag") } }));
  assert.equal(cached.status, 304);
  const image = await worker.fetch(new Request("https://site.invalid/assets/test.png"));
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from([137, 80, 78, 71]));
});

test("provider 下发保持未配置拒绝、门禁与不缓存语义", async () => {
  const worker = await workerFixture();
  const request = new Request("https://site.invalid/api/provider-config");
  assert.equal((await worker.fetch(request, {})).status, 404);
  assert.equal((await worker.fetch(new Request(request.url, { method: "POST" }), {})).status, 405);
  const env = {
    PROVIDER_KEY: "fixture-only-key",
    PROVIDER_CONFIG_TOKEN: "fixture-only-gate",
    PROVIDER_BASE_URL: "https://provider.invalid/v1",
    PROVIDER_MODEL: "fixture-model",
    PROVIDER_ENDPOINT_STYLE: "systemone",
    PROVIDER_CONFIG_TTL_SECONDS: "120",
  };
  assert.equal((await worker.fetch(request, env)).status, 403);
  const response = await worker.fetch(new Request(request.url, { headers: { "x-provider-token": "fixture-only-gate" } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true, v: 1, baseUrl: env.PROVIDER_BASE_URL, model: "fixture-model",
    endpointStyle: "systemone", key: "fixture-only-key", ttlSeconds: 120,
  });
});

test("站点构建与部署配置不再绑定匿名统计数据库或定时任务", async () => {
  const source = await readFile(bundlerUrl, "utf8");
  for (const removed of ["ingestEvent", "runDigest", "BARK_TOKEN", "DIGEST_KEY", "api.npmjs.org", "env.DB", "scheduled:"]) {
    assert.equal(source.includes(removed), false, removed);
  }
  const config = await readFile(new URL("../site/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(config, /"(?:d1_databases|triggers|crons)"/u);
});
