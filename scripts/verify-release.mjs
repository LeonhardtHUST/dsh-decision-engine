import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compareVersions } from "./detect-release.mjs";

export function verifyRelease(manifest, environment = {}) {
  assert.equal(manifest.name, "@leonhardthust/dsh-decision-engine", "Unexpected npm package");
  compareVersions(manifest.version, manifest.version);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.equal(manifest.repository?.url, "git+https://github.com/LeonhardtHUST/dsh-decision-engine.git");
  const tag = environment.RELEASE_TAG;
  if (environment.GITHUB_ACTIONS === "true") {
    assert.equal(environment.GITHUB_REPOSITORY, "LeonhardtHUST/dsh-decision-engine");
    assert.equal(environment.GITHUB_EVENT_NAME, "push", "Publication must follow a main push");
    assert.equal(environment.GITHUB_REF, "refs/heads/main", "Publication must use main");
    assert.equal(environment.RELEASE_VERSION, manifest.version, "Detected release version must match package.json");
    assert.ok(compareVersions(manifest.version, environment.PREVIOUS_VERSION) > 0, "Publication requires a version increase");
  } else if (tag !== undefined) assert.equal(tag, `v${manifest.version}`);
  const distTag = environment.NPM_DIST_TAG ?? (manifest.version.includes("-") ? "next" : "latest");
  assert.ok(["latest", "next"].includes(distTag), "Unsupported npm dist-tag");
  if (manifest.version.includes("-")) assert.notEqual(distTag, "latest", "Prereleases cannot replace latest");
  return { name: manifest.name, version: manifest.version, tag: tag ?? "not-selected", distTag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(verifyRelease(manifest, process.env), null, 2));
}
