import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, validateProviderPatch, DEFAULTS } from "../lib/index.js";

function fixture() {
  const previous = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "decision-config-"));
  process.env.DSH_HOME = home;
  mkdirSync(join(home, "dsh-decision-engine"));
  const configPath = join(home, "dsh-decision-engine", "config.yml");
  writeFileSync(configPath, "enabled: false\ntelemetryLevel: off\n");
  const routes = new Map();
  const llm = { listProviders: () => [{ id: "fixture", name: "Fixture" }], listModels: async () => [{ id: "model", name: "Review" }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "medium", name: "Medium" }] } }) };
  const services = { llm, connection: { fetch: { register: (route) => routes.set(route.path, route) } } };
  apply({ logger: { info() {}, warn() {}, debug() {} }, get: (name) => services[name], on() {}, inject(_names, callback) { callback(); }, plugin() {}, effect() {} }, {});
  const request = async (path, method = "GET", body) => {
    const response = await routes.get(path.split("?")[0]).fetch(new Request(`http://fixture.local${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: response.status, body: await response.json() };
  };
  return { request, configPath, cleanup() { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 }); } };
}

test("四种Fallback及任意宿主model/effort完整保存并回显，不静默丢字段", async () => {
  const env = fixture();
  try {
    for (const guardFallback of ["model", "session", "allow", "deny"]) {
      const result = await env.request("/api/decision-engine/config", "PUT", { enabled: true, guardEnabled: true, mode: "enforce", pointAuthorize: "enforce", guardFallback, guardFallbackProvider: "fixture", guardFallbackModel: "model", guardFallbackReasoningEffort: "custom-effort" });
      assert.equal(result.status, 200);
      assert.equal(result.body.guardFallback, guardFallback);
      assert.equal(result.body.guardFallbackReasoningEffort, "custom-effort");
      assert.equal(result.body.points.authorize, "enforce");
    }
    assert.match(readFileSync(env.configPath, "utf8"), /guardFallbackReasoningEffort: custom-effort/);
  } finally { env.cleanup(); }
});

test("宿主模型库和reasoning清单由独立只读接口提供", async () => {
  const env = fixture();
  try {
    const { status, body } = await env.request("/api/decision-engine/guard-models?provider=fixture&model=model");
    assert.equal(status, 200); assert.equal(body.available, true);
    assert.deepEqual(body.providers[0].models[0].reasoningEfforts, [{ id: "medium", name: "Medium" }]);
  } finally { env.cleanup(); }
});

test("非法Fallback/模式/多行模型标识在写盘前拒绝", () => {
  for (const patch of [{ guardFallback: "anything" }, { pointAuthorize: "true" }, { guardEnabled: "true" }, { guardPolicyMode: "legacy" }, { guardFallbackModel: "model\nsecret: value" }, { guardFallbackProvider: 1 }]) {
    assert.equal(validateProviderPatch(patch, DEFAULTS).ok, false, JSON.stringify(patch));
  }
});
