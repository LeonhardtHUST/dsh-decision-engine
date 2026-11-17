import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hashSummary, createGuardAudit, GUARD_AUDIT_VERSION, joinHostOutcome, messageVerificationSummary } from "../lib/guard/audit.js";
import { mountGuard } from "../lib/guard/listener.js";
import { PLUGIN_VERSION, recordVersionFields } from "../lib/plugin-meta.js";

const record = () => createGuardAudit({ callId: "fixture-call", toolName: "write", args: { content: "secret-fixture-token" }, context: { sessionId: "fixture-session", originalUserGoal: "private fixture goal" } });

test("audit records the installed plugin version without changing its schema", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const audit = record();
  assert.equal(PLUGIN_VERSION, manifest.version);
  assert.equal(audit.pluginVersion, manifest.version);
  assert.equal(audit.schemaVersion, GUARD_AUDIT_VERSION);
  assert.deepEqual(recordVersionFields(GUARD_AUDIT_VERSION), {
    pluginVersion: manifest.version,
    schemaVersion: GUARD_AUDIT_VERSION,
  });
  const joined = joinHostOutcome(audit, { callId: "fixture-call", sessionId: "fixture-session", result: { isError: false } });
  assert.equal(joined.pluginVersion, audit.pluginVersion);
  assert.equal(joined.schemaVersion, audit.schemaVersion);
});

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

test("audit keeps the raw mandatory reason beside the approval-availability reason", () => {
  // 用户文案/错误码仍由 reasonCode 决定（approval-policy-never）；原始强制
  // 约束另存 policyBlockReason，避免 destructive / write-outside /
  // recipient-authority 在聚合里并成同一条。
  const audit = createGuardAudit({
    reasonCode: "approval-policy-never",
    policyBlockReason: "destructive-operation-requires-approval",
  });
  assert.equal(audit.reasonCode, "approval-policy-never");
  assert.equal(audit.policyBlockReason, "destructive-operation-requires-approval");
  assert.equal(createGuardAudit({}).policyBlockReason, "unknown");
  assert.equal(createGuardAudit({ policyBlockReason: "" }).policyBlockReason, "unknown");
});

test("message verification summary has a fixed privacy-safe schema", () => {
  const context = { messageVerification: {
    senderId: "raw-sender-canary", rootId: "raw-root-canary", targetId: "raw-target-canary",
    membership: "same-tree", continuable: true, hostLocal: true, globalGuardRegistered: true,
    downstreamIndependentApproval: "unknown", verificationStage: "guard", verificationReason: "guard-not-registered",
    name: "private-name-canary", body: "private-body-canary", error: "private-error-canary",
  } };
  const summary = messageVerificationSummary(context);
  assert.deepEqual(Object.keys(summary), ["senderIdHash", "rootIdHash", "targetIdHash", "membership", "continuable", "hostLocal", "globalGuardRegistered", "downstreamIndependentApproval", "verificationStage", "verificationReason"]);
  for (const field of ["senderIdHash", "rootIdHash", "targetIdHash"]) assert.match(summary[field], /^[a-f0-9]{64}$/);
  assert.equal(summary.senderIdHash, hashSummary("raw-sender-canary").sha256);
  assert.equal(summary.downstreamIndependentApproval, "unknown");
  assert.doesNotMatch(JSON.stringify(summary), /canary/);
  const audit = createGuardAudit({ toolName: "send_message", context });
  assert.deepEqual(audit.messageVerification, summary);
  assert.doesNotMatch(JSON.stringify(audit), /canary/);
  assert.equal(Object.hasOwn(record(), "messageVerification"), false);
  assert.equal(Object.hasOwn(createGuardAudit({ toolName: "write", context }), "messageVerification"), false);
});

test("message verification summary rejects unexpected enums, strings and identifiers", () => {
  const verification = { senderId: {}, rootId: "", targetId: null, membership: "outside", continuable: "true", hostLocal: 1, globalGuardRegistered: "true", downstreamIndependentApproval: {}, verificationStage: "private-stage-canary", verificationReason: new Error("private-error-canary") };
  const summary = messageVerificationSummary({ messageVerification: verification });
  assert.ok(Object.values(summary).every((value) => value === "unknown"));
  assert.deepEqual(messageVerificationSummary(), summary);
  assert.deepEqual(messageVerificationSummary(null), summary);
  assert.equal(createGuardAudit({ toolName: "send_message" }).messageVerification.verificationReason, "unknown");
  assert.deepEqual(messageVerificationSummary({ messageVerification: { continuable: false, hostLocal: false, globalGuardRegistered: false, downstreamIndependentApproval: false } }), { ...summary, continuable: false, hostLocal: false, globalGuardRegistered: false, downstreamIndependentApproval: false });
});

test("listener audit and detail scores share one message verification summary", async () => {
  const records = [];
  const details = [];
  const hooks = new Map();
  const services = {
    tools: { guard: () => () => {} },
    subagents: { rootOf: () => ({ id: "root-id-canary" }), resolveName: () => "target-id-canary", listDescendants: () => [{ id: "target-id-canary", kind: "child", mode: "continuable" }] },
  };
  mountGuard({ get: (name) => services[name], on: (name, listener) => hooks.set(name, listener) }, {
    getConfig: () => ({ enabled: true, guardPolicyMode: "enforce" }), reloadOwnConfig: async () => {},
    effectivePointModes: () => ({ authorize: "enforce" }), client: {},
    logDecision: async (entry) => records.push(entry), recordGuardDetail: (entry) => details.push(entry),
  });
  const agent = { id: "sender-id-canary", session: { id: "fixture-session", snapshotEvents: () => [] } };
  const exec = { agent, token: Symbol("fixture"), callId: "fixture-call", name: "send_message", arguments: { agent: "private-name-canary", message: "private-body-canary" } };
  let delivered = false;
  await hooks.get("tools/pre-execute")(exec, () => { delivered = true; return { kind: "allow" }; });
  assert.equal(delivered, true);
  assert.equal(records.length, 1);
  assert.equal(details.length, 1);
  assert.equal(records[0].audit.messageVerification, details[0].scores.messageVerification);
  assert.equal(records[0].audit.messageVerification.verificationReason, "verified");
  assert.doesNotMatch(JSON.stringify(records[0].audit.messageVerification), /canary/);
  assert.doesNotMatch(JSON.stringify(details[0].scores), /canary/);
  hooks.get("tools/result")(exec, { isError: false });
  assert.equal(records[1].audit.messageVerification, records[0].audit.messageVerification);
  services.subagents.listDescendants = () => { throw new Error("private-query-error-canary"); };
  const failed = await hooks.get("tools/pre-execute")({ ...exec, token: Symbol("failed-fixture"), callId: "failed-fixture-call" }, () => assert.fail("failed membership query cannot delegate"));
  assert.equal(failed.kind, "deny");
  assert.equal(records[2].audit.messageVerification, details[1].scores.messageVerification);
  assert.equal(records[2].audit.messageVerification.verificationReason, "descendants-query-failed");
  assert.equal(records[2].audit.messageVerification.downstreamIndependentApproval, "unknown");
  assert.doesNotMatch(JSON.stringify(records[2].audit), /canary/);
  assert.doesNotMatch(JSON.stringify(details[1].scores), /canary/);
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
