import { readFileSync } from "node:fs";

function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" && manifest.version.trim().length > 0
      ? manifest.version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

export const PLUGIN_VERSION = readPluginVersion();

export function recordVersionFields(schemaVersion) {
  return { pluginVersion: PLUGIN_VERSION, schemaVersion };
}
