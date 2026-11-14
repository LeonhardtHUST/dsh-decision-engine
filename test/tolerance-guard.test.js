import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../lib/index.js";
import { TOLERANCE_LEVELS } from "../lib/tolerance.js";

function setup({ tolerance = "default", approvalPolicy = "never", denyTool = false, body } = {}) {
  const originalHome = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "dsh-tolerance-policy-"));
  process.env.DSH_HOME = home;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body ?? { answers: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const hooks = new Map();
  const services = {
    permissionPresets: { current: () => "fixture", resolve: () => ({ sandbox: "danger-full-access", approval: approvalPolicy }) },
    approval: { overrideOf: () => approvalPolicy, request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: home }) },
    tools: { executable: () => denyTool ? undefined : { name: "fixture" } },
    connection: { fetch: { register() {} } },
  };
  const ctx = {
    get: (name) => services[name],
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) { const list = hooks.get(name) ?? []; list.push(listener); hooks.set(name, list); return () => {}; },
    inject(_names, callback) { callback(); }, plugin() {}, effect() {},
  };
  apply(ctx, {});
  const configPath = join(home, "dsh-decision-engine", "config.yml");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, Object.entries({
    enabled: true, mode: "enforce", pointAuthorize: "enforce", guardPolicyMode: "enforce", tolerance,
    provider: "bamboonode", baseUrl: "https://example.invalid/v1", model: "fixture-model",
    keyStorage: "config", bamboonodeApiKey: "fixture-not-a-real-credential",
  }).map(([key, value]) => `${key}: ${value}`).join("\n") + "\n");
  const agent = { id: "fixture-session", session: { id: "fixture-session", snapshotEvents: () => [] } };
  return {
    calls,
    async run(name, args) {
      let nextCalled = false;
      const decision = await hooks.get("tools/pre-execute")[0]({ name, arguments: args, callId: `fixture-${name}`, agent }, async () => { nextCalled = true; return { kind: "proceed" }; });
      return { decision, nextCalled };
    },
    restore() { globalThis.fetch = originalFetch; if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome; },
  };
}

for (const tolerance of TOLERANCE_LEVELS) {
  test(`${tolerance}: strict local query bypasses erroneous model risk without bypassing host`, async () => {
    const env = setup({ tolerance, body: { answers: { risk: { type: "choice", choice: "high", confidence: 1 } } } });
    try {
      const { decision, nextCalled } = await env.run("list_agents", {});
      assert.equal(nextCalled, true);
      assert.equal(decision.kind, "proceed");
      assert.equal(env.calls.length, 0);
    } finally { env.restore(); }
  });

  test(`${tolerance}: external effect under host never cannot be delegated to a model`, async () => {
    const env = setup({ tolerance, approvalPolicy: "never" });
    try {
      const { decision, nextCalled } = await env.run("web_fetch", { url: "https://example.invalid/fixture" });
      assert.equal(nextCalled, false);
      assert.equal(decision.kind, "deny");
      assert.equal(env.calls.length, 0);
    } finally { env.restore(); }
  });

  test(`${tolerance}: required approval remains ask when a host approval channel exists`, async () => {
    const env = setup({ tolerance, approvalPolicy: "ask" });
    try {
      const { decision, nextCalled } = await env.run("pwsh", { command: "node fixture.js" });
      assert.equal(nextCalled, false);
      assert.equal(decision.kind, "ask");
      assert.equal(env.calls.length, 0);
    } finally { env.restore(); }
  });
}

test("all tolerances preserve explicit host tool denial including list_agents", async () => {
  for (const tolerance of TOLERANCE_LEVELS) {
    const env = setup({ tolerance, denyTool: true });
    try {
      const { decision, nextCalled } = await env.run("list_agents", {});
      assert.equal(nextCalled, false);
      assert.equal(decision.kind, "deny");
      assert.equal(env.calls.length, 0);
    } finally { env.restore(); }
  }
});
