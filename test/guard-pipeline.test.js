import test from "node:test";
import assert from "node:assert/strict";
import { buildModelReviewState, canMemoizeVerdict, createVerdictMemoEntry, idleEvaluation, interruptedReviewAction, reuseEvaluation, summarizeModelEvaluation } from "../lib/guard/pipeline.js";

test("idle evaluations are independent and contain no model request", () => {
  const primary = idleEvaluation();
  const secondary = idleEvaluation();
  assert.deepEqual(primary, { status: "not_requested", provider: null, model: null, latencyMs: null, reason: null });
  assert.notEqual(primary, secondary);
});

test("memo reuse only marks successful evaluations as cache hits", () => {
  for (const status of ["completed", "cache_hit", "failed", "not_requested"]) {
    const evaluation = Object.freeze({ status, provider: "fixture", model: "advisory", latencyMs: 25, reason: "fixture-reason", validationErrors: ["fixture-error"] });
    const reused = reuseEvaluation(evaluation);
    assert.deepEqual(reused, { ...evaluation, ...(["completed", "cache_hit"].includes(status) ? { status: "cache_hit" } : {}), latencyMs: null });
    assert.equal(evaluation.status, status);
    assert.equal(evaluation.latencyMs, 25);
  }
});

test("memo eligibility excludes degraded, failed and unavailable outcomes without losing explicit denials", () => {
  const successful = {
    action: { kind: "deny", reason: "fallback-model-deny" },
    primary: { ...idleEvaluation(), status: "completed" },
    secondary: { ...idleEvaluation(), status: "completed" },
    fallback: { kind: "deny", reason: "fallback-model-deny" },
  };
  assert.equal(canMemoizeVerdict(successful), true);
  for (const change of [
    { primary: { ...successful.primary, status: "failed" } },
    { secondary: { ...successful.secondary, status: "failed" } },
    { degradedReason: "primary-review-exception" },
    { action: { kind: "cancel", reason: "review-cancelled" } },
    { action: { kind: "deny", reasonCode: "review-timeout" } },
    { fallback: { kind: "deny", reason: "fallback-review-failed" } },
    { fallback: { kind: "deny", reason: "fallback-model-unavailable" } },
    { fallback: { ...successful.fallback, failure: { stage: "stream", code: "UNKNOWN" } } },
    { secondary: { ...successful.secondary, failure: { stage: "stream", code: "UNKNOWN" } } },
  ]) assert.equal(canMemoizeVerdict({ ...successful, ...change }), false);
  for (const reason of ["fallback-deny", "fallback-allow-soft-review-only"]) {
    assert.equal(canMemoizeVerdict({ ...successful, fallback: { reason }, secondary: idleEvaluation() }), true);
  }
  assert.equal(canMemoizeVerdict({ ...successful, fallback: undefined, primary: idleEvaluation(), secondary: idleEvaluation() }), false);
});

test("interrupted review preserves cancellation precedence and safe-only timeout delegation", () => {
  for (const status of ["safe", "unknown", "requires_approval", "deny", undefined]) {
    const mandatory = status === undefined ? undefined : { status };
    assert.deepEqual(interruptedReviewAction({ aborted: true, mandatory }), { kind: "cancel", reason: "review-cancelled" });
    assert.deepEqual(interruptedReviewAction({ aborted: false, mandatory }), { kind: status === "safe" ? "delegate" : "deny", reason: "review-timeout", reasonCode: "review-timeout" });
  }
});

test("memo entries preserve the normalized verdict, failure provenance and fallback base action", () => {
  const verdict = Object.freeze({ kind: "deny", reason: "fixture display", reasonCode: "fallback-model-deny", humanReason: "fixture human reason" });
  const primary = Object.freeze({ ...idleEvaluation(), status: "failed", reason: "answer-shape-mismatch" });
  const secondary = Object.freeze({ status: "completed", provider: "fixture", model: "review", latencyMs: 12 });
  const fallback = Object.freeze({ kind: "deny", fallback: "session", selection: { provider: "fixture", model: "review" } });
  const entry = createVerdictMemoEntry({ at: 123, verdict, primary, secondary, decisionSource: "fallback_model", baseAction: { kind: "ask" }, fallback, degradedReason: "answer-shape-mismatch" });
  assert.deepEqual(entry, { at: 123, verdict, primary, secondary, decisionSource: "fallback_model", baseAction: "ask", fallback, degradedReason: "answer-shape-mismatch" });
  assert.equal(entry.verdict, verdict);
  assert.equal(entry.primary, primary);
  assert.equal(entry.secondary, secondary);
  assert.equal(entry.fallback, fallback);
  const minimal = createVerdictMemoEntry({ at: 124, verdict, primary, secondary, decisionSource: "primary_model" });
  assert.equal(minimal.baseAction, "deny");
  assert.equal(minimal.fallback, null);
  assert.equal(minimal.degradedReason, undefined);
});

test("model review state redacts and truncates untrusted fields without mutating inputs", () => {
  const state = { tool: "fixture", permissionContext: { mandatory: "unknown" }, apiKey: "fixture-only" };
  const context = { originalUserGoal: "g".repeat(250), goalSource: "fixture-source" };
  const reviewState = buildModelReviewState({ state, argsPreview: "a".repeat(250), recent: "r".repeat(250), context, config: { maxStateChars: 500 } });
  assert.deepEqual(reviewState, { ...state, apiKey: "[redacted]", args_preview: "a".repeat(100), recent: "r".repeat(100), recentAuthority: "untrusted-context-only", trustedContext: { originalUserGoal: "g".repeat(100), goalSource: "fixture-source" } });
  assert.equal(state.apiKey, "fixture-only");
  assert.equal(state.args_preview, undefined);
  assert.equal(context.originalUserGoal.length, 250);
  assert.notEqual(reviewState.permissionContext, state.permissionContext);
});

test("model review state keeps the existing default budget, floor and missing goal marker", () => {
  for (const [maxStateChars, expectedLength] of [[undefined, 1200], [0, 1200], [50, 100], ["1000", 200]]) {
    const state = buildModelReviewState({ state: {}, argsPreview: "a".repeat(2000), recent: "r".repeat(2000), context: {}, config: { maxStateChars } });
    assert.equal(state.args_preview.length, expectedLength);
    assert.equal(state.recent.length, expectedLength);
    assert.equal(state.trustedContext.originalUserGoal, "unknown");
  }
});

test("evaluation summary keeps final-stage status, judge identity and total latency", () => {
  const primary = { status: "failed", provider: "fixture", model: "advisory", latencyMs: 25 };
  const secondary = { status: "completed", provider: "fixture", model: "review", latencyMs: 12 };
  const summary = summarizeModelEvaluation(primary, secondary);
  assert.deepEqual(summary.requested, [primary, secondary]);
  assert.deepEqual(summary.modelEvaluation, { status: "completed", primary, fallback: secondary });
  assert.equal(summary.judge, secondary);
  assert.equal(summary.latencyMs, 37);
  const failed = summarizeModelEvaluation(secondary, primary);
  assert.equal(failed.modelEvaluation.status, "failed");
  const reused = summarizeModelEvaluation(reuseEvaluation(secondary), idleEvaluation());
  assert.equal(reused.modelEvaluation.status, "completed");
  assert.equal(reused.judge.status, "cache_hit");
  assert.equal(reused.latencyMs, null);
});

test("evaluation summary preserves idle and provider-less failed fallback behavior", () => {
  const primary = idleEvaluation();
  const secondary = idleEvaluation();
  const idle = summarizeModelEvaluation(primary, secondary);
  assert.deepEqual(idle.requested, []);
  assert.equal(idle.modelEvaluation.status, "not_requested");
  assert.equal(idle.judge, primary);
  assert.equal(idle.latencyMs, null);
  const failed = summarizeModelEvaluation(primary, { ...secondary, status: "failed", latencyMs: 7 });
  assert.equal(failed.modelEvaluation.status, "failed");
  assert.equal(failed.judge, primary);
  assert.equal(failed.latencyMs, 7);
});
