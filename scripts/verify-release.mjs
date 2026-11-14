import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export function verifyRelease(manifest, environment = {}) {
  assert.equal(manifest.name, "@leonhardthust/dsh-decision-engine", "Unexpected npm package");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/, "Invalid release version");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.equal(manifest.repository?.url, "git+https://github.com/LeonhardtHUST/dsh-decision-engine.git");
  const tag = environment.RELEASE_TAG;
  if (environment.GITHUB_ACTIONS === "true") {
    assert.equal(environment.GITHUB_REPOSITORY, "LeonhardtHUST/dsh-decision-engine");
    assert.ok(["push", "workflow_dispatch"].includes(environment.GITHUB_EVENT_NAME), "Untrusted release trigger");
    assert.equal(tag, `v${manifest.version}`, "Release tag must match package.json");
    if (environment.GITHUB_EVENT_NAME === "push") assert.equal(environment.GITHUB_REF, `refs/tags/${tag}`);
    else assert.equal(environment.GITHUB_REF, "refs/heads/main", "Manual publication must use main");
  } else if (tag !== undefined) assert.equal(tag, `v${manifest.version}`);
  const distTag = environment.NPM_DIST_TAG ?? "latest";
  assert.ok(["latest", "next"].includes(distTag), "Unsupported npm dist-tag");
  if (manifest.version.includes("-")) assert.notEqual(distTag, "latest", "Prereleases cannot replace latest");
  return { name: manifest.name, version: manifest.version, tag: tag ?? "not-selected", distTag };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-release.mjs")) {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(verifyRelease(manifest, process.env), null, 2));
}
