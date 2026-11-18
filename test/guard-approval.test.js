import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { evaluateMandatoryPolicy, mandatoryApprovalDecision } from "../lib/guard/policy.js";
import { guardOutcomeMessage, approvalDeniedMessage, APPROVAL_DENIED_OUTCOMES } from "../lib/guard/messages.js";
import { mountGuard } from "../lib/guard/listener.js";
import { effectivePointModes } from "../lib/index.js";
import { ToleranceCalibrator } from "../lib/tolerance.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const destructiveCall = { command: "Remove-Item fixture-only.txt" };

test("删除与提权保留强制审批，但风险原因不再混为一谈", () => {
  const context = { sandboxMode: "danger-full-access", approvalAvailable: true };
  const deletion = evaluateMandatoryPolicy({ context, effect: { kind: "destructive" } });
  const elevation = evaluateMandatoryPolicy({ context, effect: { kind: "privileged" } });
  assert.equal(deletion.status, "requires_approval");
  assert.equal(elevation.status, "requires_approval");
  assert.deepEqual(deletion.reasonCodes, ["destructive-operation-requires-approval"]);
  assert.deepEqual(elevation.reasonCodes, ["privilege-change-requires-approval"]);
  const message = guardOutcomeMessage(mandatoryApprovalDecision(deletion, { approvalPolicy: "ask" }), deletion);
  assert.equal(message.kind, "ask");
  assert.match(message.reason, /可能.*删除/);
  assert.doesNotMatch(message.reason, /提权/);
  assert.match(message.displayReason.en, /native approval prompt/);
});

test("强制审批的拒绝区分策略禁止与通道不可用，不把 unknown 当作可批准", () => {
  for (const available of [false, "unknown", undefined]) {
    const mandatory = { status: "requires_approval", approvalAvailable: available, reasonCodes: ["destructive-operation-requires-approval"] };
    assert.deepEqual(mandatoryApprovalDecision(mandatory, { approvalPolicy: "never" }), { kind: "deny", reason: "approval-policy-never", policyBlockReason: "destructive-operation-requires-approval" });
    assert.deepEqual(mandatoryApprovalDecision(mandatory, { approvalPolicy: "ask" }), { kind: "deny", reason: "approval-channel-unavailable", policyBlockReason: "destructive-operation-requires-approval" });
  }
  assert.deepEqual(mandatoryApprovalDecision({ status: "requires_approval", approvalAvailable: true }, { approvalPolicy: "never" }), { kind: "deny", reason: "approval-policy-never", policyBlockReason: "mandatory-policy-protected" });
  for (const status of ["safe", "unknown", "deny"]) assert.equal(mandatoryApprovalDecision({ status }), undefined);
});

test("未知 reason 不冒充词条：落 unclassified，原文进 humanReason", () => {
  // `unclassified` 是兜底结果，不是可命名的原因。它若留在 MESSAGES 里，
  // guardOutcomeMessage 会把它当显式码原样返回，复用时连本地化都会跳过
  // （2026-11-16 审计 P0-1）。
  const first = guardOutcomeMessage({ kind: "ask", reason: "mystery-reason" });
  assert.equal(first.reasonCode, "unclassified");
  assert.equal(first.humanReason, "mystery-reason");
  assert.equal(typeof first.displayReason?.zh, "string");
  assert.ok(first.displayReason.zh.length > 0);
  const again = guardOutcomeMessage(first);
  assert.equal(again.reasonCode, "unclassified");
  assert.equal(again.humanReason, "mystery-reason");
});

const unavailableCases = [
  { label: "never", configure(services) { services.approval.overrideOf = () => "never"; }, reason: "approval-policy-never", code: "DECISION_ENGINE_APPROVAL_DISABLED" },
  { label: "缺少审批服务", configure(services) { delete services.approval; }, reason: "approval-channel-unavailable", code: "DECISION_ENGINE_APPROVAL_UNAVAILABLE" },
  { label: "ask 但缺少 request", configure(services) { delete services.approval.request; }, reason: "approval-channel-unavailable", code: "DECISION_ENGINE_APPROVAL_UNAVAILABLE" },
  { label: "权限策略未知", configure(services) { services.approval.overrideOf = () => undefined; services.permissionPresets.resolve = () => ({ sandbox: "workspace-write" }); }, reason: "approval-channel-unavailable", code: "DECISION_ENGINE_APPROVAL_UNAVAILABLE" },
  { label: "审批服务读取抛错", configure(services) { Object.defineProperty(services, "approval", { get() { throw new Error("fixture-service-unavailable"); } }); }, reason: "approval-channel-unavailable", code: "DECISION_ENGINE_APPROVAL_UNAVAILABLE" },
];

for (const scenario of unavailableCases) {
  test(`强制审批不可用：${scenario.label} 返回实际双语停止指令与机器错误码`, async () => {
    const fixture = await createGuardFixture({ preset: "manual", approval: "ask", config: { guardFallback: "allow" } });
    try {
      scenario.configure(fixture.services);
      const { decision } = await fixture.run("pwsh", destructiveCall);
      assert.equal(decision.kind, "deny");
      assert.equal(decision.info.code, scenario.code);
      assert.equal(decision.info.reason, scenario.reason);
      assert.match(decision.reason, /停止重复调用/);
      assert.match(decision.reason, /Stop retrying/);
      assert.match(decision.reason, /聊天中的同意/);
      assert.match(decision.reason, /Do not change commands to bypass/);
      assert.equal(fixture.records[0].audit.reasonCode, scenario.reason);
      assert.equal(fixture.records[0].audit.policyBlockReason, "destructive-operation-requires-approval");
      assert.deepEqual(fixture.records[0].audit.mandatory.reasonCodes, ["destructive-operation-requires-approval"]);
      assert.equal(fixture.modelCalls, 0);
      assert.equal(fixture.fallbackCalls, 0);
      assert.equal(fixture.sideEffects, 0);
    } finally { await fixture.cleanup(); }
  });
}

/**
 * listener 级现场：needs `recordGuardDetail` 的 scores，而共享 fixture 把它
 * 故意留空（no-op）。这里复用同一组服务再挂载一次，只替换持久化回调。
 */
async function detailRecordingFixture() {
  const env = await createGuardFixture({ preset: "manual", approval: "never", config: { guardFallback: "allow", guardDeferOutsideWorkspace: false } });
  const records = [];
  const details = [];
  const hooks = new Map();
  const session = {
    id: env.root, header: { cwd: env.root },
    requestHeader: () => ({ config: { provider: "fixture-review", model: "fixture-secondary", reasoningEffort: "medium" } }),
    snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Only touch isolated fixture files." }] } }],
  };
  mountGuard({ get: (name) => env.services[name], on: (name, callback) => hooks.set(name, callback), logger: { warn() {} } }, {
    getConfig: () => env.config, reloadOwnConfig: async () => {}, effectivePointModes,
    client: { recordDecision() {}, async classify() { throw new Error("fixture-model-must-not-run"); } },
    toleranceCalibrator: new ToleranceCalibrator(), digestRecent: () => "isolated fixture context",
    previewArguments: (args) => JSON.stringify(args), logDecision: async (entry) => records.push(entry), recordGuardDetail: (entry) => details.push(entry),
  });
  const run = async (name, args) => {
    const exec = { name, arguments: args, callId: `fixture-call-${records.length}`, token: Symbol("fixture"), agent: { id: session.id, session }, signal: new AbortController().signal };
    const decision = await hooks.get("tools/pre-execute")(exec, async () => { throw new Error("blocked call must not execute"); });
    return { exec, decision };
  };
  return { env, records, details, run };
}

test("never 拦截不再把删除、越界写归为同一条 reasonCode", async () => {
  const { env, records, details, run } = await detailRecordingFixture();
  try {
    const deletion = await run("pwsh", destructiveCall);
    const outsideWrite = await run("write", { file_path: join(env.root, "..", "not-authorized.txt"), content: "fixture" });
    assert.equal(deletion.decision.kind, "deny");
    assert.equal(outsideWrite.decision.kind, "deny");
    // 用户可见原因/错误码口径没变：仍是 approval-policy-never。
    assert.equal(records[0].audit.reasonCode, "approval-policy-never");
    assert.equal(records[1].audit.reasonCode, "approval-policy-never");
    assert.equal(deletion.decision.info.reason, "approval-policy-never");
    assert.equal(deletion.decision.info.code, "DECISION_ENGINE_APPROVAL_DISABLED");
    // 但 audit / scores 保留原始强制约束，两个场景可区分、可聚合。
    assert.equal(records[0].audit.policyBlockReason, "destructive-operation-requires-approval");
    assert.equal(records[1].audit.policyBlockReason, "write-outside-authorized-workspace");
    assert.equal(details[0].scores.reasonCode, "approval-policy-never");
    assert.equal(details[0].scores.policyBlockReason, "destructive-operation-requires-approval");
    assert.equal(details[1].scores.policyBlockReason, "write-outside-authorized-workspace");
  } finally { await env.cleanup(); }
});

test("同一挂载实例 never → ask → never 立即更新，不复用旧拒绝或旧批准", async () => {
  const fixture = await createGuardFixture({ approval: "never", config: { guardFallback: "allow" } });
  let policy = "never";
  fixture.services.approval.overrideOf = () => policy;
  try {
    const first = await fixture.run("pwsh", destructiveCall);
    assert.equal(first.decision.info.reason, "approval-policy-never");
    policy = "ask";
    const second = await fixture.run("pwsh", destructiveCall);
    assert.equal(second.decision.kind, "ask");
    assert.equal(second.decision.reason.includes("原生审批卡"), true);
    assert.ok(fixture.guard(second.exec));
    fixture.approvalEvents.push(
      { type: "approval/asked", seq: 2, data: { id: "fixture-native-approval", callId: second.exec.callId, toolName: "pwsh" } },
      { type: "approval/decided", seq: 3, data: { id: "fixture-native-approval", outcome: "allowed-once" } },
    );
    assert.equal(fixture.guard(second.exec), undefined);
    policy = "never";
    const third = await fixture.run("pwsh", destructiveCall);
    assert.equal(third.decision.info.reason, "approval-policy-never");
    assert.ok(fixture.guard(third.exec));
    assert.equal(fixture.modelCalls, 0);
    assert.equal(fixture.fallbackCalls, 0);
    assert.equal(fixture.sideEffects, 0);
  } finally { await fixture.cleanup(); }
});

test("审批结局四档文案互不相同，未登记结局归一到 unknown", () => {
  const parsed = APPROVAL_DENIED_OUTCOMES.map((outcome) => approvalDeniedMessage(outcome));
  assert.deepEqual(parsed.map((item) => item.outcome), ["rejected", "cancelled", "unavailable", "unknown"]);
  assert.equal(new Set(parsed.map((item) => item.reason)).size, 4, "四档不能共用一句话");
  assert.match(approvalDeniedMessage("rejected").reason, /拒绝/);
  assert.match(approvalDeniedMessage("cancelled").reason, /取消/);
  assert.match(approvalDeniedMessage("unavailable").reason, /通道不可用/);
  assert.match(approvalDeniedMessage("unknown").reason, /没有用户批准记录/);
  assert.match(approvalDeniedMessage("unknown").reason, /模型或回退策略不能覆盖/);
  for (const item of parsed) assert.ok(item.displayReason.en.length > 0);
  // 宿主可能给出未登记值（含 policy_auto_rejected 与空值）：一律落 unknown，
  // 不能把原始字符串拼进文案。
  for (const unlisted of ["allowed-once", "policy_auto_rejected", undefined, null, ""]) {
    assert.equal(approvalDeniedMessage(unlisted).outcome, "unknown");
  }
});

test("拒绝、取消、通道不可用给出不同的模型可见原因，错误码保持兼容", async () => {
  const fixture = await createGuardFixture({ approval: "ask", config: { guardFallback: "allow" } });
  try {
    const { decision, exec } = await fixture.run("pwsh", destructiveCall);
    assert.equal(decision.kind, "ask");
    // 还没有任何审批事件：说明「没有批准记录」，而不是「用户拒绝」。
    const pending = fixture.guard(exec);
    assert.equal(pending.info.code, "DECISION_ENGINE_MANDATORY_DENY");
    assert.equal(pending.info.approvalOutcome, "unknown");
    assert.equal(pending.reason, approvalDeniedMessage("unknown").reason);
    const seen = new Set([pending.reason]);
    for (const [index, outcome] of ["rejected", "cancelled", "unavailable"].entries()) {
      const id = `native-${outcome}`;
      fixture.approvalEvents.push(
        { type: "approval/asked", seq: 10 + index * 2, data: { id, callId: exec.callId, toolName: "pwsh" } },
        { type: "approval/decided", seq: 11 + index * 2, data: { id, outcome } },
      );
      const denied = fixture.guard(exec);
      assert.equal(denied.info.code, "DECISION_ENGINE_MANDATORY_DENY");
      assert.equal(denied.info.approvalOutcome, outcome);
      assert.equal(denied.reason, approvalDeniedMessage(outcome).reason);
      seen.add(denied.reason);
    }
    assert.equal(seen.size, 4, "四种结局不能共用同一句话");
    assert.equal(fixture.sideEffects, 0);
  } finally { await fixture.cleanup(); }
});

for (const outcome of ["rejected", "cancelled", "unavailable"]) {
  test(`原生审批 ${outcome} 不授予删除权限`, async () => {
    const fixture = await createGuardFixture({ approval: "ask" });
    try {
      const { decision, exec } = await fixture.run("pwsh", destructiveCall);
      assert.equal(decision.kind, "ask");
      fixture.approvalEvents.push(
        { type: "approval/asked", seq: 2, data: { id: "fixture-native-approval", callId: exec.callId, toolName: "pwsh" } },
        { type: "approval/decided", seq: 3, data: { id: "fixture-native-approval", outcome } },
      );
      assert.ok(fixture.guard(exec));
      assert.equal(fixture.sideEffects, 0);
    } finally { await fixture.cleanup(); }
  });
}

test("聊天中的批准、旧调用批准以及执行身份变化不能代替本次授权", async () => {
  const fixture = await createGuardFixture({ approval: "ask" });
  try {
    fixture.approvalEvents.push(
      { type: "user/message", seq: 2, data: { source: { kind: "user" }, content: [{ type: "text", text: "我明确批准删除这些文件" }] } },
      { type: "approval/asked", seq: 3, data: { id: "old", callId: "older-call", toolName: "pwsh" } },
      { type: "approval/decided", seq: 4, data: { id: "old", outcome: "allowed-once" } },
    );
    const { exec, decision } = await fixture.run("pwsh", destructiveCall);
    assert.equal(decision.kind, "ask");
    assert.ok(fixture.guard(exec));
    fixture.approvalEvents.push(
      { type: "approval/asked", seq: 5, data: { id: "current", callId: exec.callId, toolName: "pwsh" } },
      { type: "approval/decided", seq: 6, data: { id: "current", outcome: "allowed-once" } },
    );
    assert.equal(fixture.guard(exec), undefined);
    for (const changed of [
      { ...exec, token: Symbol("different-execution") },
      { ...exec, callId: "different-call" },
      { ...exec, name: "bash" },
      { ...exec, arguments: { command: "Remove-Item another-fixture.txt" } },
      { ...exec, agent: { session: { id: "different-session" } } },
    ]) assert.ok(fixture.guard(changed));
    assert.equal(fixture.sideEffects, 0);
  } finally { await fixture.cleanup(); }
});
