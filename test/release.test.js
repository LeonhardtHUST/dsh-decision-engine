import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { verifyRelease } from "../scripts/verify-release.mjs";
import { readPackageArchive, verifyPackageFiles } from "../scripts/verify-package.mjs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const environment = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "LeonhardtHUST/dsh-decision-engine", GITHUB_EVENT_NAME: "push", GITHUB_REF: `refs/tags/v${manifest.version}`, RELEASE_TAG: `v${manifest.version}`, NPM_DIST_TAG: "latest" };

function archive(name = "package/package.json", type = "0", content = "{}") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100, 8);
  header.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return gzipSync(Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - Buffer.byteLength(content) % 512) % 512), Buffer.alloc(1024)]));
}

test("发布身份、公开scope、仓库和版本tag一致", () => {
  assert.equal(verifyRelease(manifest, environment).name, "@leonhardthust/dsh-decision-engine");
  for (const changed of [{ name: "dsh-decision-engine" }, { publishConfig: { access: "restricted" } }, { repository: { url: "git+https://github.com/zuosus/dsh-decision-engine.git" } }]) {
    assert.throws(() => verifyRelease({ ...manifest, ...changed }, environment));
  }
});

test("不匹配tag、不可信仓库和手动非main发布均失败关闭", () => {
  for (const changed of [{ RELEASE_TAG: "v0.0.0" }, { GITHUB_REPOSITORY: "someone/fork" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/other" }]) {
    assert.throws(() => verifyRelease(manifest, { ...environment, ...changed }));
  }
  assert.doesNotThrow(() => verifyRelease(manifest, { ...environment, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" }));
});

test("预发布不能覆盖latest，dist-tag不能注入任意shell参数", () => {
  assert.throws(() => verifyRelease({ ...manifest, version: "2.0.0-rc.1" }, { NPM_DIST_TAG: "latest" }));
  assert.doesNotThrow(() => verifyRelease({ ...manifest, version: "2.0.0-rc.1" }, { NPM_DIST_TAG: "next" }));
  assert.throws(() => verifyRelease(manifest, { NPM_DIST_TAG: "latest; command" }));
});

test("tarball读取只观察内容，不抽取文件", () => {
  const files = readPackageArchive(archive());
  assert.equal(files.get("package.json").toString(), "{}");
  assert.throws(() => verifyPackageFiles(files, manifest), /Missing packed file/);
});

test("tarball拒绝路径穿越、符号链接和重复外部身份", () => {
  assert.throws(() => readPackageArchive(archive("package/../secret")), /Unsafe archive path/);
  assert.throws(() => readPackageArchive(archive("outside/file")), /Unsafe archive path/);
  assert.throws(() => readPackageArchive(archive("package/link", "2")), /Links and extended/);
  assert.throws(() => readPackageArchive(Buffer.from("not-gzip")));
});

test("CI保留完整验证，发布依赖验证成功且凭据只进入最终发布步骤", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  for (const command of ["vp run verify", "vp run verify:guard", "vp run pack:release", "vp run verify:package"]) assert.ok(ci.includes(command));
  assert.match(publish, /needs: verify/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /--provenance/);
  assert.doesNotMatch(ci + publish, /continue-on-error|pull_request_target|git push/);
});
