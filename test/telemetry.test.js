import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply, DEFAULTS, Config } from "../lib/index.js";

for (const level of [undefined, "off", "install", "daily"]) {
  test(`匿名上报已移除：旧档位 ${String(level)} 在启动、保存与定时检查后均无请求`, async (context) => {
    const home = await mkdtemp(join(tmpdir(), "dsh-no-analytics-"));
    const dataDir = join(home, "dsh-decision-engine");
    const previousHome = process.env.DSH_HOME;
    const requests = [];
    const timers = [];
    const routes = {};
    process.env.DSH_HOME = home;
    context.mock.method(globalThis, "fetch", async (...args) => {
      requests.push(args);
      throw new Error("Unexpected network request in isolated fixture");
    });
    context.mock.method(globalThis, "setInterval", (callback) => {
      timers.push(callback);
      return { unref() {} };
    });
    try {
      await mkdir(dataDir, { recursive: true });
      const legacyConfig = level === undefined ? "" : `telemetryLevel: ${level}\n`;
      await writeFile(join(dataDir, "config.yml"), `enabled: false\nserverProvider: false\n${legacyConfig}`);
      const connection = { fetch: { register(entry) { routes[entry.path] = entry; } } };
      apply({
        logger: { info() {}, warn() {}, debug() {} },
        on() {},
        get(name) { return name === "connection" ? connection : undefined; },
        inject(_names, callback) { callback(); },
        plugin() {},
        effect() {},
      }, { telemetryLevel: level, telemetryEndpoint: "https://analytics.invalid/collect" });
      const status = await routes["/api/decision-engine/status"].fetch({ method: "GET" });
      const state = await status.json();
      assert.equal(status.status, 200);
      for (const key of ["telemetryLevel", "telemetryLevels", "telemetryEndpoint"]) {
        assert.equal(Object.hasOwn(state, key), false, key);
      }
      const saved = await routes["/api/decision-engine/config"].fetch({
        method: "PUT",
        text: async () => JSON.stringify({ thinkMode: "auto" }),
      });
      assert.equal(saved.status, 200);
      assert.equal(Object.hasOwn(await saved.json(), "telemetryLevel"), false);
      const config = await readFile(join(dataDir, "config.yml"), "utf8");
      assert.equal(config.includes("telemetryLevel: daily"), level === "daily");
      for (const callback of timers) await callback();
      await delay(50);
      assert.deepEqual(requests, []);
      const files = await readdir(dataDir);
      assert.equal(files.includes("analytics.json"), false);
      assert.equal(files.includes("analytics.json.tmp"), false);
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await delay(50);
      await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 20 });
    }
  });
}

test("默认值、schema 与运行代码不再包含匿名上报实现", async () => {
  for (const key of ["telemetryLevel", "telemetryEndpoint"]) {
    assert.equal(Object.hasOwn(DEFAULTS, key), false);
    assert.equal(Object.hasOwn(Config({}), key), false);
  }
  const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  for (const removed of ["TelemetryReporter", "startTelemetry", "telemetryTimer", 'from "./telemetry.js"']) {
    assert.equal(source.includes(removed), false, removed);
  }
  for (const removed of ["../lib/telemetry.js", "../site/migrations/0001_init.sql", "../site/migrations/0002_plugin_dimension.sql"]) {
    await assert.rejects(readFile(new URL(removed, import.meta.url), "utf8"), { code: "ENOENT" });
  }
});
