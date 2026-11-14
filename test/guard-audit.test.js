import test from "node:test";
import assert from "node:assert/strict";
import { hashSummary, createGuardAudit, joinHostOutcome } from "../lib/guard/audit.js";

const record = () => createGuardAudit({ callId: "fixture-call", toolName: "write", args: { content: "secret-fixture-token" }, context: { sessionId: "fixture-session", originalUserGoal: "private fixture goal" } });

test("audit stores hashes rather than arguments, user goal or raw model bodies", () => {
  const audit = record();
  const text = JSON.stringify(audit);
  assert.doesNotMatch(text, /secret-fixture-token|private fixture goal/);
  assert.match(audit.args_summary.sha256, /^[a-f0-9]{64}$/);
  assert.match(audit.goal_summary.sha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.hostApprovalStatus, "unknown");
  assert.equal(audit.hostFinalAction, "unknown");
  assert.equal(audit.effectOutcome, "unknown");
});

test("summary hashing is canonical and cyclic/unavailable input remains unknown", () => {
  assert.deepEqual(hashSummary({ first: 1, second: 2 }), hashSummary({ second: 2, first: 1 }));
  const cyclic = {};
  cyclic.cycle = cyclic;
  assert.equal(hashSummary(cyclic).sha256, "unknown");
  assert.equal(hashSummary(undefined).sha256, "unknown");
});

test("plugin defer does not mean host executed or approved", () => {
  const audit = createGuardAudit({ pluginReturnedAction: "defer_to_host" });
  assert.equal(audit.pluginReturnedAction, "defer_to_host");
  assert.equal(audit.hostFinalAction, "unknown");
  assert.equal(audit.effectOutcome, "unknown");
});

test("host outcome joins only exact session and call id", () => {
  const audit = record();
  assert.equal(joinHostOutcome(audit, { callId: "other", sessionId: "fixture-session", result: { isError: false } }), audit);
  assert.equal(joinHostOutcome(audit, { callId: "fixture-call", sessionId: "other", result: { isError: false } }), audit);
  const joined = joinHostOutcome(audit, { callId: "fixture-call", sessionId: "fixture-session", result: { isError: false, value: "secret-fixture-output" } });
  assert.equal(joined.effectOutcome, "reported-success");
  assert.equal(joined.hostFinalAction, "unknown");
  assert.equal(audit.effectOutcome, "unknown");
  assert.doesNotMatch(JSON.stringify(joined), /secret-fixture-output/);
});

test("approval status, returned error and final action remain distinct", () => {
  const joined = joinHostOutcome(record(), { callId: "fixture-call", sessionId: "fixture-session", approvalOutcome: "policy_auto_rejected", hostFinalAction: "deny", result: { isError: true } });
  assert.equal(joined.hostApprovalStatus, "policy_auto_rejected");
  assert.equal(joined.hostFinalAction, "deny");
  assert.equal(joined.effectOutcome, "reported-error");
  const invalid = joinHostOutcome(record(), { callId: "fixture-call", sessionId: "fixture-session", approvalOutcome: "allow-all", hostFinalAction: "executed", result: {} });
  assert.equal(invalid.hostApprovalStatus, "unknown");
  assert.equal(invalid.hostFinalAction, "unknown");
  assert.equal(invalid.effectOutcome, "unknown");
});
