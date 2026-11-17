import test from "node:test";
import assert from "node:assert/strict";
import { mountGuard } from "../lib/guard/listener.js";
import { ToleranceCalibrator } from "../lib/tolerance.js";

function memoryMemoFixture(options = {}) {
  const state = { primary: "valid", fallback: "allow", denied: false, preset: "auto", ...options };
  const records = [];
  const details = [];
  const requests = { primary: 0, fallback: 0, delegated: 0 };
  let guard;
  let controller;
  const config = { enabled: true, guardEnabled: true, guardPolicyMode: "enforce", tolerance: "default", guardFallback: "session", timeoutMs: 1000, guardDeadlineMs: 1000 };
  const session = {
    id: "memory-memo-session",
    snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: "memory-provider", model: "memory-review" } }),
  };
  const services = {
    permissionPresets: { current: () => state.preset, resolve: () => ({ approval: "never", sandbox: "workspace-write" }) },
    approval: { overrideOf: () => "never" },
    tools: { executable: () => state.denied ? undefined : {}, guard(callback) { guard = callback; return () => {}; } },
    llm: { async *stream() {
      requests.fallback += 1;
      if (state.fallback === "throw") throw Object.assign(new Error("fixture transport error"), { code: "ECONNRESET" });
      if (state.fallback === "timeout") await new Promise(() => {});
      if (state.fallback === "cancel") { controller.abort(); await new Promise(() => {}); }
      yield { type: "text-delta", text: state.fallback === "invalid" ? "{}" : JSON.stringify({ action: state.fallback }) };
      yield { type: "finish", reason: { kind: "stop" } };
    } },
  };
  const actor = { id: "memory-memo-actor", session, ctx: { get: (name) => name === "llm" && state.fallback === "unavailable" ? undefined : services[name] } };
  const hooks = new Map();
  const ctx = { get: (name) => services[name], on: (name, callback) => hooks.set(name, callback), logger: { warn() {} } };
  const listener = mountGuard(ctx, {
    getConfig: () => config,
    reloadOwnConfig: async () => {},
    effectivePointModes: () => ({ authorize: "enforce" }),
    client: {
      recordDecision() {},
      async classify() {
        requests.primary += 1;
        if (state.primary === "throw") throw new Error("fixture primary failure");
        if (state.primary === "degraded") return { degraded: "fixture-degraded" };
        if (state.primary === "timeout") await new Promise(() => {});
        if (state.primary === "cancel") { controller.abort(); await new Promise(() => {}); }
        return { provider: "memory-provider", model: "memory-advisory", latencyMs: 19, answers: {
          risk: { type: "choice", choice: "medium", confidence: 0.9 },
          irreversible: { type: "noul", noul: 0.05 },
          matches_task: { type: "noul", noul: 0.99 },
          injection_suspect: { type: "noul", noul: 0.01 },
        } };
      },
    },
    toleranceCalibrator: new ToleranceCalibrator(),
    digestRecent: () => "memory fixture",
    previewArguments: JSON.stringify,
    logDecision: async ({ audit }) => records.push(audit),
    recordGuardDetail: (entry) => details.push(entry),
  });
  return {
    state, config, records, details, requests,
    async run() {
      controller = new AbortController();
      const exec = { agent: actor, name: "memory_fixture_tool", arguments: { query: "same-memory-input" }, token: Symbol("memory-memo"), callId: `memory-call-${records.length}`, signal: controller.signal };
      const decision = await listener(exec, async () => { requests.delegated += 1; return { kind: "memory-delegate" }; });
      return { exec, decision, guard: () => guard(exec) };
    },
  };
}

for (const failure of ["throw", "invalid", "unavailable"]) {
  test(`fallback ${failure} denies once but reevaluates after recovery`, async () => {
    const fixture = memoryMemoFixture({ fallback: failure });
    const first = await fixture.run();
    assert.equal(first.decision.kind, "deny");
    assert.ok(first.guard());
    assert.equal(fixture.records[0].reused, false);
    const failureInfo = fixture.records[0].fallback.failure;
    assert.deepEqual(failureInfo, {
      stage: failure === "throw" ? "stream" : failure === "invalid" ? "schema" : "selection",
      code: failure === "throw" ? "UNKNOWN" : failure === "invalid" ? "INVALID_SCHEMA" : "MODEL_UNAVAILABLE",
      httpStatus: null,
      finishReason: null,
    });
    assert.deepEqual(fixture.records[0].modelEvaluation.fallback.failure, failureInfo);
    assert.deepEqual(fixture.details[0].scores.modelEvaluation.fallback.failure, failureInfo);
    assert.deepEqual(fixture.details[0].state.modelEvaluation.fallback.failure, failureInfo);
    if (fixture.details[0].result) assert.deepEqual(fixture.details[0].result.answers.modelEvaluation.fallback.failure, failureInfo);
    fixture.state.fallback = "allow";
    const second = await fixture.run();
    assert.equal(second.decision.kind, "memory-delegate");
    assert.equal(second.guard(), undefined);
    assert.equal(fixture.requests.primary, 2);
    assert.equal(fixture.requests.fallback, failure === "unavailable" ? 1 : 2);
    assert.equal(fixture.records[1].reused, false);
    assert.equal(fixture.records[1].cacheStatus, "miss");
    assert.equal(fixture.records[1].modelEvaluation.fallback.status, "completed");
  });
}

for (const primary of ["throw", "degraded"]) {
  test(`primary ${primary} is not cached even when fallback succeeds`, async () => {
    const fixture = memoryMemoFixture({ primary });
    assert.equal((await fixture.run()).decision.kind, "memory-delegate");
    assert.equal(fixture.records[0].modelEvaluation.primary.status, "failed");
    fixture.state.primary = "valid";
    assert.equal((await fixture.run()).decision.kind, "memory-delegate");
    assert.equal(fixture.requests.primary, 2);
    assert.equal(fixture.requests.fallback, 2);
    assert.equal(fixture.records[1].reused, false);
    assert.equal(fixture.records[1].modelEvaluation.primary.status, "completed");
  });
}

for (const fallback of ["allow", "deny"]) {
  test(`successful fallback ${fallback} stays cached with null current latency`, async () => {
    const fixture = memoryMemoFixture({ fallback });
    const first = await fixture.run();
    fixture.state.fallback = fallback === "allow" ? "deny" : "allow";
    const second = await fixture.run();
    assert.equal(first.decision.kind, fallback === "allow" ? "memory-delegate" : "deny");
    assert.equal(second.decision.kind, first.decision.kind);
    assert.equal(Boolean(second.guard()), fallback === "deny");
    assert.deepEqual(fixture.requests, { primary: 1, fallback: 1, delegated: fallback === "allow" ? 2 : 0 });
    const audit = fixture.records[1];
    assert.equal(audit.reused, true);
    assert.equal(audit.reasonCode, `fallback-model-${fallback}`);
    assert.equal(audit.modelEvaluation.primary.status, "cache_hit");
    assert.equal(audit.modelEvaluation.fallback.status, "cache_hit");
    assert.equal(audit.modelEvaluation.primary.latencyMs, null);
    assert.equal(audit.modelEvaluation.fallback.latencyMs, null);
    assert.equal(fixture.details[1].result.latencyMs, null);
  });
}

for (const policy of ["allow", "deny"]) {
  test(`explicit fallback ${policy} policy remains memoizable`, async () => {
    const fixture = memoryMemoFixture();
    fixture.config.guardFallback = policy;
    const first = await fixture.run();
    const second = await fixture.run();
    assert.equal(second.decision.kind, first.decision.kind);
    assert.equal(first.decision.kind, policy === "allow" ? "memory-delegate" : "deny");
    assert.equal(fixture.requests.primary, 1);
    assert.equal(fixture.requests.fallback, 0);
    assert.equal(fixture.records[1].reused, true);
    assert.equal(fixture.records[1].decisionSource, "fallback_policy");
    assert.equal(fixture.details[1].result.latencyMs, null);
  });
}

for (const stage of ["primary", "fallback"]) {
  for (const interruption of ["timeout", "cancel"]) {
    test(`${stage} ${interruption} is not cached and a fresh call can recover`, async () => {
      const fixture = memoryMemoFixture({ [stage]: interruption });
      if (interruption === "timeout") fixture.config.guardDeadlineMs = 5;
      const first = await fixture.run();
      assert.equal(first.decision.kind, interruption === "cancel" ? "cancel" : "deny");
      assert.ok(first.guard());
      assert.equal(fixture.records[0].reused, false);
      fixture.state.primary = "valid";
      fixture.state.fallback = "allow";
      fixture.config.guardDeadlineMs = 1000;
      const second = await fixture.run();
      assert.equal(second.decision.kind, "memory-delegate");
      assert.equal(fixture.requests.primary, 2);
      assert.equal(fixture.records[1].reused, false);
      assert.equal(fixture.records[1].cacheStatus, "miss");
    });
  }
}

test("actor tool permission checks precede a cached successful verdict", async () => {
  const fixture = memoryMemoFixture();
  assert.equal((await fixture.run()).decision.kind, "memory-delegate");
  fixture.state.denied = true;
  const blocked = await fixture.run();
  assert.equal(blocked.decision.kind, "deny");
  assert.ok(blocked.guard());
  assert.equal(fixture.records[1].mandatory.status, "deny");
  assert.equal(fixture.records[1].reasonCode, "host-tool-access-denied");
  assert.equal(fixture.records[1].reused, false);
  assert.equal(fixture.requests.primary, 1);
  assert.equal(fixture.requests.fallback, 1);
});
