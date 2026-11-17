/**
 * 可证明无效的沙箱权限请求（LOG-002）：
 *
 * `sandbox_permissions` / `justification` 是宿主 `dsh-sandbox` 的提权参数。
 * 宿主只在「严格更宽 + 非空说明」时才把它当成需要审批的升级；同名模式是
 * no-op，非法枚举、full→workspace-write 这种更窄请求、缺说明等都在审批之前
 * 就判 `SANDBOX_ESCALATION_INVALID_ARGUMENT`。插件必须把这几类分开：
 *
 *   - 合法同级：继续 1.16.4 的局部归一化，按普通调用判定；
 *   - 真正越级：保留 privileged + 原生审批；
 *   - 可证明无效：`invalid_request`，本地 deny，不发审批也不调模型，
 *     且错误码/文案独立，不把「参数写错」说成「换个审批策略就能过」。
 *
 * 纯函数与隔离 fixture：不执行真实 shell、不调真实模型、不发网络。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolEffect, TOOL_EFFECT_KINDS } from "../lib/guard/effects.js";
import { evaluateMandatoryPolicy, mandatoryApprovalDecision } from "../lib/guard/policy.js";
import { guardOutcomeMessage } from "../lib/guard/messages.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const FULL = "danger-full-access";
const WS = "workspace-write";
const INVALID = "invalid-sandbox-permission-request";
const INVALID_TEXT_ZH = "权限请求参数无效；本次未发起审批或授予权限。请按当前有效沙箱与工具参数契约修正，不要切换审批策略绕过";
const INCOMPATIBLE_TEXT_ZH = "回退模型不支持所配置的思考档位，请在设置中选择该模型实际支持的档位；未自动更换模型或档位。";

const inside = (sandboxMode) => ({ sandboxMode, fileTargetScope: "inside" });
const writeArgs = { file_path: "allowed.txt", content: "fixture" };
const editArgs = { file_path: "allowed.txt", old_string: "a", new_string: "b" };
const shellArgs = { command: "node fixture.js", description: "fixture only" };

function judge(toolName, args, context = {}) {
  const effect = classifyToolEffect({ toolName, args, trustedContext: context });
  return { effect, mandatory: evaluateMandatoryPolicy({ context, effect }) };
}

function assertInvalid(effect, mandatory, label) {
  assert.equal(effect.kind, "invalid_request", label);
  assert.equal(effect.known, true, label);
  assert.equal(effect.highImpact, true, label);
  assert.deepEqual(effect.reasonCodes, [INVALID], label);
  assert.equal(effect.evidence.length, 1, label);
  assert.equal(effect.evidence[0].source, "host-escalation-contract", label);
  assert.ok(["write", "edit", "bash", "pwsh"].includes(effect.evidence[0].toolName), label);
  assert.ok(["sandbox_permissions", "justification"].includes(effect.evidence[0].field), label);
  assert.ok(["invalid-value", "invalid-type", "missing-justification", "non-widening-target", "orphan-justification"].includes(effect.evidence[0].problem), label);
  assert.equal(mandatory.status, "deny", label);
  assert.deepEqual(mandatory.reasonCodes, [INVALID], label);
}

test("invalid_request 是独立 effect 类别，固定原因码不夹带原始参数", () => {
  assert.ok(TOOL_EFFECT_KINDS.includes("invalid_request"));
  const canary = "fixture-canary-permission-value";
  const effect = classifyToolEffect({ toolName: "write", args: { ...writeArgs, sandbox_permissions: canary }, trustedContext: inside(FULL) });
  assert.equal(effect.kind, "invalid_request");
  assert.deepEqual(effect.reasonCodes, [INVALID]);
  assert.ok(!JSON.stringify(effect).includes(canary), "证据里不能回显调用方给的任意值");
  assert.ok(!JSON.stringify(effect.evidence).includes("justification"), "证据只记固定字段名/问题类别");
});

test("已知 write/edit/bash/pwsh 的非法枚举与类型归 invalid_request", () => {
  const cases = [
    ["write", () => writeArgs], ["edit", () => editArgs],
    ["bash", () => shellArgs], ["pwsh", () => shellArgs],
  ];
  for (const [toolName, makeArgs] of cases) {
    for (const bad of ["read-only", "bogus", "", 1, true, null, {}, []]) {
      const { effect, mandatory } = judge(toolName, { ...makeArgs(), sandbox_permissions: bad }, inside(FULL));
      assertInvalid(effect, mandatory, `${toolName}:${String(bad)}`);
    }
  }
});

test("显式非 same 缺/空/非字符串说明归 invalid_request", () => {
  for (const toolName of ["write", "edit", "bash", "pwsh"]) {
    for (const extra of [{}, { justification: "" }, { justification: "   " }, { justification: 1 }, { justification: null }, { justification: {} }]) {
      const args = toolName === "write" ? writeArgs : toolName === "edit" ? editArgs : shellArgs;
      const { effect, mandatory } = judge(toolName, { ...args, sandbox_permissions: FULL, ...extra }, inside(WS));
      assertInvalid(effect, mandatory, `${toolName}:${JSON.stringify(extra)}`);
    }
  }
});

test("full→workspace-write 更窄请求归 invalid_request，不被静默削字段", () => {
  for (const [toolName, args] of [["write", writeArgs], ["edit", editArgs], ["bash", shellArgs], ["pwsh", shellArgs]]) {
    for (const justification of [undefined, "fixture: narrower request"]) {
      const request = { ...args, sandbox_permissions: WS, ...(justification === undefined ? {} : { justification }) };
      const { effect, mandatory } = judge(toolName, request, inside(FULL));
      assertInvalid(effect, mandatory, `${toolName}:${String(justification)}`);
      assert.equal(request.sandbox_permissions, WS, "调用参数不被改写");
    }
  }
});

test("只有说明没有请求时，非空/非字符串说明归 invalid_request；fs/bash 空白说明仍当省略", () => {
  for (const toolName of ["write", "edit", "bash"]) {
    const args = toolName === "write" ? writeArgs : toolName === "edit" ? editArgs : shellArgs;
    const orphan = judge(toolName, { ...args, justification: "fixture: why" }, inside(FULL));
    assertInvalid(orphan.effect, orphan.mandatory, `${toolName}:orphan`);
    assert.equal(judge(toolName, { ...args, justification: "" }, inside(FULL)).effect.kind, "unknown", `${toolName}:blank-orphan`);
    const integerOrphan = judge(toolName, { ...args, justification: 1 }, inside(FULL));
    assertInvalid(integerOrphan.effect, integerOrphan.mandatory, `${toolName}:integer-orphan`);
  }
  // pwsh 在 approve 之前无条件校验说明：缺少 sandbox_permissions 时给出说明也无效。
  for (const justification of ["fixture: why", "", "   "]) {
    const orphan = judge("pwsh", { ...shellArgs, justification }, inside(FULL));
    assertInvalid(orphan.effect, orphan.mandatory, `pwsh:orphan:${justification}`);
  }
});

test("合法同级仍按 1.16.4 归一化，原始参数保持不变", () => {
  for (const mode of [FULL, WS]) {
    for (const [toolName, base] of [["write", writeArgs], ["edit", editArgs]]) {
      for (const extra of [{}, { justification: "" }, { justification: "same mode" }]) {
        const args = Object.freeze({ ...base, sandbox_permissions: mode, ...extra });
        const snapshot = structuredClone(args);
        const { effect, mandatory } = judge(toolName, args, inside(mode));
        assert.equal(effect.kind, "write_workspace", `${toolName}/${mode}`);
        assert.equal(mandatory.status, "safe", `${toolName}/${mode}`);
        assert.deepEqual(args, snapshot);
        assert.equal(args.sandbox_permissions, mode);
      }
    }
    // 无 scope 证据时仍保守：same-mode 归一化只剔除元字段，不凭空判 safe。
    assert.equal(judge("write", { ...writeArgs, sandbox_permissions: mode }, { sandboxMode: mode }).mandatory.status, "unknown");
  }
  // bash 同模式可省说明，但命令副作用仍需静态判定。
  assert.equal(judge("bash", { ...shellArgs, sandbox_permissions: FULL }, inside(FULL)).effect.kind, "unknown");
  // pwsh 同模式必须带非空说明；归一化后按命令契约判定。
  const pwsh = judge("pwsh", { ...shellArgs, sandbox_permissions: FULL, justification: "fixture: same mode" }, inside(FULL));
  assert.notEqual(pwsh.effect.kind, "invalid_request");
  assert.notEqual(pwsh.effect.kind, "privileged");
});

test("真正严格更宽仍是 privileged，并在 ask/never 下走既有审批语义", () => {
  for (const [ctxMode, requested] of [[WS, FULL], ["read-only", WS], ["read-only", FULL]]) {
    const context = { sandboxMode: ctxMode, fileTargetScope: "inside", approvalAvailable: true };
    for (const [toolName, base] of [["write", writeArgs], ["edit", editArgs], ["bash", shellArgs], ["pwsh", shellArgs]]) {
      const { effect, mandatory } = judge(toolName, { ...base, sandbox_permissions: requested, justification: "fixture: real escalation" }, context);
      assert.equal(effect.kind, "privileged", `${toolName} ${ctxMode}->${requested}`);
      assert.equal(mandatory.status, "requires_approval");
      assert.equal(mandatoryApprovalDecision(mandatory, { approvalPolicy: "ask" }).kind, "ask");
      assert.deepEqual(mandatoryApprovalDecision(mandatory, { approvalPolicy: "never" }), { kind: "deny", reason: "approval-policy-never", policyBlockReason: "privilege-change-requires-approval" });
    }
  }
});

test("未知工具、有效 mode 未知与 pwsh 说明校验保持保守边界", () => {
  // 未知工具即使携带合法同名字段，仍不能按宿主提权语义处理。
  for (const toolName of ["shell", "future_tool", "read", "skill"]) {
    for (const value of [FULL, WS, "bogus", 1, null]) {
      const { effect, mandatory } = judge(toolName, { command: "fixture", file_path: "fixture.txt", sandbox_permissions: value, justification: "fixture" }, inside(FULL));
      assert.equal(effect.kind, "privileged", `${toolName}:${String(value)}`);
      assert.equal(mandatory.status, "requires_approval");
    }
  }
  // 有效 mode 未知：合法请求保持 privileged，不归一化、不推断降档。
  for (const ctxMode of [undefined, "unknown", "bogus"]) {
    const { effect, mandatory } = judge("write", { ...writeArgs, sandbox_permissions: FULL, justification: "fixture: unknown mode" }, { sandboxMode: ctxMode, fileTargetScope: "inside" });
    assert.equal(effect.kind, "privileged", String(ctxMode));
    assert.equal(mandatory.status, "requires_approval");
    // fs/bash 同模式可省说明，所以未知 mode 下缺说明也不能证明 invalid。
    assert.equal(judge("write", { ...writeArgs, sandbox_permissions: FULL }, { sandboxMode: ctxMode }).effect.kind, "privileged", String(ctxMode));
    assert.equal(judge("bash", { ...shellArgs, sandbox_permissions: FULL }, { sandboxMode: ctxMode }).effect.kind, "privileged", String(ctxMode));
  }
  // pwsh 的说明校验不看当前 mode：缺说明始终是 invalid。
  assert.equal(judge("pwsh", { ...shellArgs, sandbox_permissions: FULL }, { sandboxMode: undefined }).effect.kind, "invalid_request");
});

test("listener：invalid 在 ask/never 均本地 deny，零模型、零回退，错误码独立", async () => {
  for (const approval of ["ask", "never"]) {
    const env = await createGuardFixture({ sandbox: FULL, preset: FULL, approval, config: { tolerance: "default", guardFallback: "session" } });
    try {
      const args = { ...writeArgs, sandbox_permissions: WS };
      const { decision, exec } = await env.run("write", args);
      assert.equal(decision.kind, "deny", approval);
      assert.equal(decision.info.code, "DECISION_ENGINE_INVALID_PERMISSION_REQUEST", approval);
      assert.equal(decision.info.reason, INVALID, approval);
      assert.equal(decision.reason, INVALID_TEXT_ZH, approval);
      assert.equal(env.modelCalls, 0, approval);
      assert.equal(env.fallbackCalls, 0, approval);
      assert.equal(env.sideEffects, 0, approval);
      const audit = env.records[0].audit;
      assert.equal(audit.reasonCode, INVALID);
      assert.equal(audit.effect.kind, "invalid_request");
      assert.equal(audit.mandatory.status, "deny");
      assert.deepEqual(audit.mandatory.reasonCodes, [INVALID]);
      assert.doesNotMatch(decision.reason, /请用户自行将宿主审批策略切换为 ask|do not change commands/i, "无效请求不引导切换审批策略");
      assert.equal(env.guard(exec).info.code, "DECISION_ENGINE_MANDATORY_DENY", "下游仍拒绝");
    } finally { await env.cleanup(); }
  }
});

test("listener：真正升级仍保留旧错误码，不混成 invalid", async () => {
  const env = await createGuardFixture({ sandbox: WS, preset: WS, approval: "never", config: { tolerance: "default", guardFallback: "allow" } });
  try {
    const { decision } = await env.run("write", { ...writeArgs, sandbox_permissions: FULL, justification: "fixture: real escalation" });
    assert.equal(decision.kind, "deny");
    assert.equal(decision.info.code, "DECISION_ENGINE_APPROVAL_DISABLED");
    assert.equal(decision.info.reason, "approval-policy-never");
    assert.equal(env.records[0].audit.mandatory.status, "requires_approval");
    assert.equal(env.modelCalls, 0);
    assert.equal(env.fallbackCalls, 0);
  } finally { await env.cleanup(); }
});

test("listener：observe 只记录并原样放行，参数不被改写", async () => {
  const env = await createGuardFixture({ sandbox: FULL, preset: FULL, approval: "never", config: { mode: "observe", pointAuthorize: "observe" } });
  try {
    const args = Object.freeze({ ...writeArgs, sandbox_permissions: WS });
    const snapshot = structuredClone(args);
    const { decision } = await env.run("write", args);
    assert.equal(decision.kind, "allow", "observe 不拦截，交宿主决定");
    assert.equal(env.sideEffects, 1);
    assert.deepEqual(args, snapshot, "观察模式不修改原始参数");
    const audit = env.records[0].audit;
    assert.equal(audit.effect.kind, "invalid_request", "观察候选仍如实记录分类");
    assert.equal(audit.pluginReturnedAction, "defer_to_host");
  } finally { await env.cleanup(); }
});

test("listener：fallback.failure 存在即标 failed，不误标 completed，也不缓存失败", async () => {
  const env = await createGuardFixture({ preset: "auto", sandbox: WS, approval: "never", config: { tolerance: "default", guardFallback: "session" } });
  const originalLlm = env.services.llm;
  try {
    // 没有可用的 stream：回退在发请求前就失败（stage=selection），没有 selection。
    env.services.llm = {};
    const first = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(first.decision.kind, "deny");
    const failed = env.records[0].audit;
    assert.equal(failed.modelEvaluation.fallback.status, "failed", "failure 存在不能记成 not_requested/completed");
    assert.equal(failed.modelEvaluation.status, "failed");
    assert.equal(failed.fallback.failure.stage, "selection");
    assert.equal(failed.decisionSource, "fallback_model");
    assert.equal(failed.reused, false);
    assert.equal(env.fallbackCalls, 0);
    // 服务恢复后同一参数必须重新审查，不能复用失败结论。
    env.services.llm = originalLlm;
    const second = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(second.decision.kind, "allow");
    assert.equal(env.modelCalls, 2);
    assert.equal(env.fallbackCalls, 1);
    assert.equal(env.records[1].audit.reused, false);
    assert.equal(env.records[1].audit.modelEvaluation.fallback.status, "completed");
  } finally { await env.cleanup(); }
});

test("listener：策略型回退未发起模型请求时仍是 not_requested", async () => {
  const env = await createGuardFixture({ preset: "auto", sandbox: WS, approval: "never", config: { tolerance: "default", guardFallback: "deny" } });
  try {
    const { decision } = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(decision.kind, "deny");
    const audit = env.records[0].audit;
    assert.equal(audit.fallback.reason, "fallback-deny");
    assert.equal(audit.fallback.failure, undefined);
    assert.equal(audit.modelEvaluation.fallback.status, "not_requested");
  } finally { await env.cleanup(); }
});

test("listener：fallback-model-incompatible 的 selection 失败标 failed 且不发起 stream", async () => {
  const env = await createGuardFixture({ preset: "auto", sandbox: WS, approval: "never", config: { tolerance: "default", guardFallback: "session" } });
  const originalLlm = env.services.llm;
  try {
    // 会话模型 fixture/review 声明 medium，而 exact model 只支持 low：预检必须在
    // stream 之前判不兼容，且不自动换模型或档位。
    env.services.llm = {
      ...originalLlm,
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: "Fixture review", reasoning: { efforts: [{ id: "low", name: "Low" }] } }),
    };
    const first = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(first.decision.kind, "deny");
    assert.equal(first.decision.info.reason, "fallback-model-incompatible");
    const audit = env.records[0].audit;
    assert.equal(audit.reasonCode, "fallback-model-incompatible");
    assert.equal(audit.fallback.failure.stage, "selection");
    assert.equal(audit.fallback.failure.code, "UNSUPPORTED_REASONING_EFFORT");
    assert.equal(audit.modelEvaluation.fallback.status, "failed", "selection 失败不能标 completed");
    assert.equal(audit.modelEvaluation.status, "failed");
    assert.match(first.decision.reason, /不支持所配置的思考档位/);
    assert.equal(env.fallbackCalls, 0, "预检失败不得发起 stream");
    // 失败不缓存：再次调用仍重新审查，且仍不 stream。
    const second = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(second.decision.kind, "deny");
    assert.equal(env.records[1].audit.reused, false);
    assert.equal(env.modelCalls, 2);
    assert.equal(env.fallbackCalls, 0);
  } finally { await env.cleanup(); }
});

test("invalid 与 fallback-model-incompatible 的固定双语文案", () => {
  const invalid = guardOutcomeMessage({ kind: "deny", reason: INVALID });
  assert.equal(invalid.reasonCode, INVALID);
  assert.equal(invalid.reason, INVALID_TEXT_ZH);
  assert.doesNotMatch(invalid.reason, /实际触发原因|请用户自行将宿主审批策略切换为 ask|approval policy to ask/i);
  // 词条本身是双语的（ask 分支会把它作为审批卡标题展示）。
  const invalidPair = guardOutcomeMessage({ kind: "ask", reason: "fixture", reasonCode: INVALID });
  assert.equal(invalidPair.displayReason.zh, INVALID_TEXT_ZH);
  assert.match(invalidPair.displayReason.en, /permission request is malformed/i);
  assert.match(invalidPair.displayReason.en, /do not switch the approval policy/i);

  const incompatible = guardOutcomeMessage({ kind: "deny", reason: "fallback-model-incompatible" });
  assert.equal(incompatible.reasonCode, "fallback-model-incompatible");
  assert.equal(incompatible.reason, INCOMPATIBLE_TEXT_ZH);
  assert.match(incompatible.reason, /未自动更换模型或档位/);
  const incompatiblePair = guardOutcomeMessage({ kind: "ask", reason: "fixture", reasonCode: "fallback-model-incompatible" });
  assert.equal(incompatiblePair.displayReason.zh, INCOMPATIBLE_TEXT_ZH);
  assert.match(incompatiblePair.displayReason.en, /does not support the configured reasoning effort/i);
  assert.match(incompatiblePair.displayReason.en, /were not changed automatically/i);

  // 旧机器码/旧文案不受影响。
  const never = guardOutcomeMessage({ kind: "deny", reason: "approval-policy-never" });
  assert.equal(never.reasonCode, "approval-policy-never");
  assert.match(never.reason, /停止重复调用/);
});
