import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function versionParts(version) {
  assert.equal(typeof version, "string", "Package version must be a string");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  assert.ok(match, "Invalid package version");
  const prerelease = match[4]?.split(".") ?? [];
  assert.ok(prerelease.every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")), "Invalid numeric prerelease identifier");
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareVersions(left, right) {
  const first = versionParts(left);
  const second = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (first.core[index] !== second.core[index]) return first.core[index] > second.core[index] ? 1 : -1;
  }
  if (!first.prerelease.length || !second.prerelease.length) return first.prerelease.length ? -1 : second.prerelease.length ? 1 : 0;
  const length = Math.max(first.prerelease.length, second.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const before = first.prerelease[index];
    const after = second.prerelease[index];
    if (before === undefined || after === undefined) return before === undefined ? -1 : 1;
    if (before === after) continue;
    const beforeNumeric = /^\d+$/.test(before);
    const afterNumeric = /^\d+$/.test(after);
    if (beforeNumeric && afterNumeric) return BigInt(before) > BigInt(after) ? 1 : -1;
    if (beforeNumeric !== afterNumeric) return beforeNumeric ? -1 : 1;
    return before > after ? 1 : -1;
  }
  return 0;
}

export function publicationPlan(previous, current) {
  const expectedName = "@leonhardthust/dsh-decision-engine";
  assert.equal(previous?.name, expectedName, "Previous package identity does not match");
  assert.equal(current?.name, expectedName, "Current package identity does not match");
  const comparison = compareVersions(current.version, previous.version);
  assert.ok(comparison >= 0, "Version rollback cannot trigger a publication");
  return { changed: comparison > 0, previousVersion: previous.version, version: current.version, distTag: current.version.includes("-") ? "next" : "latest" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], "Pass the manifest from the push's before commit");
  const previous = JSON.parse(await readFile(process.argv[2], "utf8"));
  const current = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const plan = publicationPlan(previous, current);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${plan.changed}\nprevious_version=${plan.previousVersion}\nversion=${plan.version}\ndist_tag=${plan.distTag}\n`);
  }
  console.log(JSON.stringify(plan, null, 2));
}
