import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { join } from "node:path";
import { createReviewDeadline, guardReviewBudget } from "../lib/guard/deadline.js";
import { mountGuard } from "../lib/guard/listener.js";
import { effectivePointModes, StartluxClient } from "../lib/index.js";
import { ToleranceCalibrator } from "../lib/tolerance.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stalled = () => new Promise(() => {});

async function reviewFixture(options = {}) {
  const env = await createGuardFixture({ ...options, config: { guardDeadlineMs: 80, timeoutMs: 1000, ...options.config } });
  const ctx = { get: (name) => env.services[name], on: (name, listener) => env.hooks.set(name, listener), logger: { warn() {} } };
  mountGuard(ctx, {
    getConfig: () => env.config, reloadOwnConfig: async () => {}, effectivePointModes,
    client: { classify: options.classify ?? stalled, recordDecision() {} },
    toleranceCalibrator: new ToleranceCalibrator(), digestRecent: () => "fixture", previewArguments: JSON.stringify,
    logDecision: async (entry) => env.records.push(entry), recordGuardDetail() {},
  });
  return env;
}

test("shared review budget retains the existing retry ceiling unless explicitly configured", () => {
  assert.equal(guardReviewBudget({}), 30000);
  assert.equal(guardReviewBudget({ timeoutMs: 5000, retryAttempts: 3 }), 10000);
  assert.equal(guardReviewBudget({ timeoutMs: 20000, retryAttempts: 0 }), 30000);
  assert.equal(guardReviewBudget({ timeoutMs: 5000, guardDeadlineMs: 250 }), 250);
  assert.equal(guardReviewBudget({ timeoutMs: 5000, guardDeadlineMs: 0 }), 10000);
});

test("deadline races signal-ignoring work and removes abort listeners on every exit", async () => {
  const caller = new AbortController();
  const deadline = createReviewDeadline({ timeoutMs: 30, signal: caller.signal });
  await assert.rejects(deadline.run(stalled), /review-timeout/);
  assert.equal(deadline.timedOut, true);
  assert.equal(getEventListeners(deadline.signal, "abort").length, 0);
  deadline.dispose();
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  const completed = createReviewDeadline({ timeoutMs: 10000, signal: caller.signal });
  assert.equal(await completed.run(() => 42), 42);
  assert.equal(getEventListeners(completed.signal, "abort").length, 0);
  completed.dispose();
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("primary timeout denies unknown effects even when fallback policy allows", async () => {
  let primarySignal;
  const env = await reviewFixture({ config: { guardFallback: "allow" }, classify: ({ signal }) => { primarySignal = signal; return stalled(); } });
  try {
    const { decision, exec } = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(decision.kind, "deny");
    assert.equal(decision.info.reason, "review-timeout");
    assert.equal(env.records[0].audit.reasonCode, "review-timeout");
    assert.equal(env.records[0].audit.modelEvaluation.primary.status, "failed");
    assert.equal(primarySignal.aborted, true);
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.sideEffects, 0);
    assert.ok(env.guard(exec));
  } finally { await env.cleanup(); }
});

test("primary retries inherit the authorization signal and cannot restart its budget", async () => {
  let client;
  let calls = 0;
  let retrySignal;
  const env = await reviewFixture({ config: { retryAttempts: 3, bamboonodeApiKey: "fixture-key", cacheSize: 0 }, classify: (call) => client.classify(call) });
  client = new StartluxClient({
    getConfig: () => env.config, telemetryDir: env.root, logger: { warn() {} },
    fetchFn: async (_, { signal }) => {
      calls += 1;
      if (calls === 1) throw new Error("fixture-network-error");
      retrySignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  try {
    const { decision } = await env.run("mcp__fixture__query", {});
    assert.equal(decision.info.reason, "review-timeout");
    assert.equal(calls, 2);
    assert.equal(retrySignal.aborted, true);
    assert.equal(env.fallbackCalls, 0);
  } finally { await env.cleanup(); }
});

test("fallback consumes the remaining primary budget rather than restarting the clock", async () => {
  let primarySignal;
  let fallbackSignal;
  let fallbackStarted;
  const env = await reviewFixture({
    config: { guardDeadlineMs: 250 },
    classify: async ({ signal }) => { primarySignal = signal; await delay(170); return { degraded: "fixture-failed" }; },
  });
  env.services.llm.stream = async function* ({ signal }) { fallbackSignal = signal; fallbackStarted = performance.now(); await stalled(); };
  try {
    const started = performance.now();
    const { decision } = await env.run("mcp__fixture__query", { query: "fixture" });
    const finished = performance.now();
    assert.equal(decision.kind, "deny");
    assert.equal(decision.info.reason, "review-timeout");
    assert.ok(fallbackStarted - started >= 150);
    assert.ok(finished - fallbackStarted < 170, "fallback gets less than a fresh 250ms budget");
    assert.equal(primarySignal.aborted, true);
    assert.equal(fallbackSignal.aborted, true);
    assert.equal(env.records[0].audit.modelEvaluation.fallback.status, "failed");
  } finally { await env.cleanup(); }
});

test("caller abort cancels a stalled primary without waiting for deadline", async () => {
  const caller = new AbortController();
  let primarySignal;
  const env = await reviewFixture({ config: { guardDeadlineMs: 10000 }, classify: ({ signal }) => { primarySignal = signal; caller.abort(new Error("fixture-cancel")); return stalled(); } });
  const listener = env.hooks.get("tools/pre-execute");
  env.hooks.set("tools/pre-execute", (exec, next) => listener({ ...exec, signal: caller.signal }, next));
  try {
    assert.equal((await env.run("mcp__fixture__query", {})).decision.kind, "cancel");
    assert.equal(env.records[0].audit.reasonCode, "review-cancelled");
    assert.equal(primarySignal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    assert.equal(env.fallbackCalls, 0);
  } finally { await env.cleanup(); }
});

test("caller abort cancels a stalled fallback and cleans caller listeners", async () => {
  const caller = new AbortController();
  let fallbackSignal;
  const env = await reviewFixture({ config: { guardDeadlineMs: 10000 }, classify: async () => ({ degraded: "fixture-failed" }) });
  env.services.llm.stream = async function* ({ signal }) { fallbackSignal = signal; caller.abort(); await stalled(); };
  const listener = env.hooks.get("tools/pre-execute");
  env.hooks.set("tools/pre-execute", (exec, next) => listener({ ...exec, signal: caller.signal }, next));
  try {
    assert.equal((await env.run("mcp__fixture__query", {})).decision.kind, "cancel");
    assert.equal(env.records[0].audit.reasonCode, "review-cancelled");
    assert.equal(fallbackSignal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  } finally { await env.cleanup(); }
});

test("fallback timeout retains its stable code without an approval channel", async () => {
  const env = await reviewFixture({ preset: "auto", approval: "never", classify: async () => ({ degraded: "fixture-failed" }) });
  env.services.llm.stream = async function* () { await stalled(); };
  try {
    assert.equal((await env.run("mcp__fixture__query", {})).decision.info.reason, "review-timeout");
    assert.equal(env.records[0].audit.reasonCode, "review-timeout");
    assert.equal((await env.run("mcp__fixture__query", {})).decision.info.reason, "review-timeout");
    assert.equal(env.records.at(-1).audit.reasonCode, "review-timeout");
    assert.equal(env.records.at(-1).audit.reused, true);
  } finally { await env.cleanup(); }
});

test("successful reviews dispose timers before handing control to the host", async () => {
  const caller = new AbortController();
  let primarySignal;
  const env = await reviewFixture({ classify: async ({ signal }) => { primarySignal = signal; return { degraded: "fixture-failed" }; } });
  const listener = env.hooks.get("tools/pre-execute");
  env.hooks.set("tools/pre-execute", (exec, next) => listener({ ...exec, signal: caller.signal }, () => {
    assert.equal(primarySignal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    return next();
  }));
  try {
    assert.equal((await env.run("mcp__fixture__query", {})).decision.kind, "allow");
  } finally { await env.cleanup(); }
});

test("safe review timeout delegates only to the host sandbox", async () => {
  const env = await reviewFixture();
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.records[0].audit.mandatory.status, "safe");
    assert.equal(env.records[0].audit.reasonCode, "review-timeout");
    assert.equal(env.fallbackCalls, 0);
  } finally { await env.cleanup(); }
});

test("safe direct-host and mandatory approval paths do not start a deadline", async () => {
  let reads = 0;
  const env = await reviewFixture({ approval: "never", preset: "danger-full-access", classify: () => { throw new Error("must not classify"); } });
  Object.defineProperty(env.config, "guardDeadlineMs", { get() { reads += 1; throw new Error("must not start deadline"); } });
  try {
    assert.equal((await env.run("write", { file_path: "allowed.txt", content: "fixture" })).decision.kind, "allow");
    assert.equal((await env.run("write", { file_path: join(env.root, "..", "not-authorized.txt"), content: "fixture" })).decision.kind, "deny");
    assert.equal(env.records.at(-1).audit.mandatory.status, "requires_approval");
    assert.equal(reads, 0);
    assert.equal(env.fallbackCalls, 0);
  } finally { await env.cleanup(); }
});
