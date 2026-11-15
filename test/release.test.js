import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { verifyRelease } from "../scripts/verify-release.mjs";
import { compareVersions, publicationPlan } from "../scripts/detect-release.mjs";
import { readPackageArchive, verifyPackageFiles } from "../scripts/verify-package.mjs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const environment = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "LeonhardtHUST/dsh-decision-engine", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", RELEASE_VERSION: manifest.version, PREVIOUS_VERSION: "0.0.0", NPM_DIST_TAG: "latest" };

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

test("非main、未升版、错误身份或手动触发均不能绕过自动发布条件", () => {
  for (const changed of [{ RELEASE_VERSION: "0.0.0" }, { GITHUB_REPOSITORY: "someone/fork" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" }, { GITHUB_REF: `refs/tags/v${manifest.version}` }, { PREVIOUS_VERSION: manifest.version }, { PREVIOUS_VERSION: "999.0.0" }, { PREVIOUS_VERSION: undefined }]) {
    assert.throws(() => verifyRelease(manifest, { ...environment, ...changed }));
  }
  assert.doesNotThrow(() => verifyRelease(manifest, environment));
});

test("main提交只有版本增加才发版，其他manifest变化只跳过", () => {
  const previous = { ...manifest, version: "1.9.1" };
  assert.deepEqual(publicationPlan(previous, { ...manifest, version: "1.9.2" }), { changed: true, previousVersion: "1.9.1", version: "1.9.2", distTag: "latest" });
  assert.equal(publicationPlan(manifest, { ...manifest, description: "metadata only" }).changed, false);
  assert.equal(publicationPlan(previous, { ...manifest, version: "1.9.2-rc.1" }).distTag, "next");
  assert.throws(() => publicationPlan(manifest, { ...manifest, version: "0.0.1" }));
  assert.throws(() => publicationPlan({ ...previous, name: "unrelated-package" }, manifest));
});

test("升版检测遵守SemVer数值和预发布顺序，并拒绝非法输出", () => {
  for (const [older, newer] of [["1.9.2", "1.10.0"], ["1.9.2-rc.2", "1.9.2-rc.10"], ["1.9.2-1", "1.9.2-beta"], ["1.9.2-rc", "1.9.2-rc.1"], ["1.9.2-rc.1", "1.9.2"]]) {
    assert.equal(compareVersions(newer, older), 1);
    assert.equal(compareVersions(older, newer), -1);
    assert.equal(compareVersions(newer, newer), 0);
  }
  for (const version of ["01.0.0", "1.0.0-01", "1.0.0\nchanged=true", "1.0", undefined]) assert.throws(() => compareVersions(version, "1.0.0"));
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

test("CI保留完整验证，发布依赖验证成功且仅用OIDC无长期npm令牌", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  for (const command of ["vp run verify", "vp run verify:guard", "vp run pack:release", "vp run verify:package"]) assert.ok(ci.includes(command));
  assert.match(publish, /needs: \[detect, verify\]/);
  assert.match(publish, /branches: \[main\]/);
  assert.match(publish, /paths: \[package\.json\]/);
  assert.match(publish, /needs\.detect\.outputs\.changed == 'true'/);
  assert.match(publish, /github\.event\.before/);
  assert.doesNotMatch(publish, /workflow_dispatch|tags:/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /--provenance/);
  assert.ok(publish.includes('--registry "https://registry.npmjs.org/"'));
  assert.doesNotMatch(publish, /npmmirror|vp pm login/);
  assert.doesNotMatch(ci + publish, /continue-on-error|pull_request_target|git push/);
});

test("发布工作流只走OIDC：无NPM_TOKEN/NODE_AUTH_TOKEN，也不在workflow内用长期token引导", () => {
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.doesNotMatch(publish, /Configure optional npm token|_authToken|NPM_CONFIG_USERCONFIG/);
  assert.match(publish, /permissions:\s*\r?\n\s+contents: read\s*\r?\n\s+id-token: write/);
  assert.match(publish, /npm publish \.\/release-artifacts\/\*\.tgz .*--access public --provenance/);
});
