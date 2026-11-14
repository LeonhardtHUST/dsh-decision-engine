import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./verify-release.mjs";

export function readPackageArchive(compressed) {
  assert.ok(compressed.length <= 20 * 1024 * 1024, "Oversized tarball");
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, size) => header.subarray(start, start + size).toString("utf8").split("\0")[0].trim();
    const expected = Number.parseInt(field(148, 8), 8);
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(checksum, expected, "Tar header checksum mismatch");
    const size = Number.parseInt(field(124, 12) || "0", 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, "Invalid tar entry size");
    const prefix = field(345, 155);
    const name = [prefix, field(0, 100)].filter(Boolean).join("/");
    const type = field(156, 1);
    assert.ok(name.startsWith("package/") && !name.includes("\\") && !name.split("/").includes(".."), "Unsafe archive path");
    if (type === "" || type === "0") {
      assert.ok(!files.has(name), "Duplicate archive path");
      files.set(name.slice(8), tar.subarray(offset + 512, offset + 512 + size));
    } else assert.equal(type, "5", "Links and extended archive entries are not allowed");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(files.size > 0, "Empty archive");
  return files;
}

export function verifyPackageFiles(files, manifest) {
  const required = [
    "package.json", "LICENSE", "README.md", "README.zh.md", "cordis.patch.yml", "icon.svg",
    "locale/en.json", "locale/zh.json", "lib/index.js", "lib/client.js", "lib/client.charts.js",
    "lib/providers.js", "lib/guard/context.js", "lib/guard/effects.js", "lib/guard/policy.js",
    "lib/guard/advisory.js", "lib/guard/audit.js", "lib/guard/fallback.js", "lib/guard/listener.js",
    "lib/vendor/microcharts-charts.css", "docs/security-revision.md", "docs/releasing.md",
  ];
  for (const name of required) assert.ok(files.has(name), `Missing packed file: ${name}`);
  for (const name of files.keys()) {
    assert.ok(!/^(?:node_modules|test|bench|\.git|\.github|release-artifacts)\//.test(name), `Unexpected private path: ${name}`);
    assert.ok(!/(?:^|\/)(?:\.npmrc|\.credentials\.ya?ml|config\.yml|startlux\.yml|analytics\.json)$|\.(?:log|jsonl)$/.test(name), `Potential private data: ${name}`);
  }
  const packed = JSON.parse(files.get("package.json").toString("utf8"));
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  verifyRelease(packed);
  for (const name of ["lib/client.js", "lib/client.charts.js"]) {
    const registration = files.get(name).toString("utf8").match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
    assert.equal(registration?.[1], manifest.name, `Client registration mismatch: ${name}`);
  }
  assert.ok(files.get("lib/client.js").toString("utf8").includes(`const PACKAGE_NAME = "${manifest.name}"`), "Settings slot points at a different npm package");
  assert.ok(files.get("cordis.patch.yml").toString("utf8").includes(`name: '${manifest.name}'`), "Bundle points at a different npm package");
  for (const name of ["locale/en.json", "locale/zh.json"]) JSON.parse(files.get(name).toString("utf8"));
  for (const [name, data] of files) {
    if (!name.startsWith("lib/") || !name.endsWith(".js")) continue;
    for (const match of data.toString("utf8").matchAll(/(?:from\s*|import\s*\()"(\.\/[^"?]+|\.\.\/[^"?]+)"/g)) {
      const target = new URL(match[1], `https://package.invalid/${name}`).pathname.slice(1);
      assert.ok(files.has(target), `Packed import is missing: ${name} -> ${target}`);
    }
  }
  return { name: packed.name, version: packed.version, fileCount: files.size };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-package.mjs")) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const directory = process.argv[2] ? resolve(process.argv[2]) : join(root, "release-artifacts");
  const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "Expected exactly one release tarball");
  const data = await readFile(join(directory, archives[0]));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(JSON.stringify({ ...verifyPackageFiles(readPackageArchive(data), manifest), tarball: archives[0], bytes: data.length, integrity: `sha512-${createHash("sha512").update(data).digest("base64")}` }, null, 2));
}
