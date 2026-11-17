/**
 * 「原生审批被拦」的拒绝提示必须说清两件事：
 *
 *   1. 这条审批要求来自**本插件的审查规则**，不是宿主已经问过用户却被忽略；
 *   2. 实际触发的是哪条强制约束（删除、越权写、只读写、接收方权限……）。
 *
 * 第 2 点是审计现场的真实问题：`approval-policy-never` 只回答「为什么没走
 * 审批」，不回答「为什么该拦」。never 下所有强制拦截若都显示同一句话，
 * 代理和用户就看不出「删文件」和「写工作区外」的区别，只会反复重试。
 *
 * 触发原因来自 `policy.js` 的固定枚举（`mandatory.reasonCodes` /
 * `policyBlockReason`），所以必须走固定映射展示；词表之外的原因码只能出
 * 兜底话术，绝不把任意字符串拼进提示。同时 `reasonCode`（机器口径）和
 * 双语停止重试、不绕过指令都不能被这次展示改动带走。
 *
 * 纯函数单测：不挂 listener、不调模型、不读文件、不发网络。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mandatoryApprovalDecision } from "../lib/guard/policy.js";
import { guardOutcomeMessage } from "../lib/guard/messages.js";

/** CJK：汉字 + 全角标点。英文触发原因行里不该出现。 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 固定映射的逐字文案（改动这里等于改动用户看到的提示，必须是有意为之）。
 *
 * 原因码本身来自本仓库的枚举，不来自模型或调用方；词表外的值一律兜底。
 */
const TRIGGER_TEXT = {
  "recipient-authority-unverified": ["消息接收方的权限无法核实", "the recipient's authority could not be verified"],
  "privilege-change-requires-approval": ["可能提升权限或修改访问控制", "possible privilege escalation or access-control changes"],
  "destructive-operation-requires-approval": ["可能删除、清空或重置数据", "possible deletion, clearing or resetting of data"],
  "write-exceeds-read-only-permission": ["当前会话为只读权限，写入超出该权限", "the session is read-only and the write exceeds that permission"],
  "write-outside-authorized-workspace": ["写入目标在已授权工作区之外", "the write target is outside the authorized workspace"],
  "mandatory-policy-protected": ["受显式权限约束保护", "protected by an explicit permission constraint"],
};

const FALLBACK_TEXT = ["具体约束未能归类为已知规则，详见审计明细", "the specific constraint could not be classified; see the audit detail"];

/** 两条被拦分支：策略为 never / 审批通道无法确认。 */
const BLOCKED = {
  never: { approvalPolicy: "never", approvalAvailable: false, reasonCode: "approval-policy-never" },
  unavailable: { approvalPolicy: "ask", approvalAvailable: "unknown", reasonCode: "approval-channel-unavailable" },
};

/** 用真实策略函数生成一份「需要审批但走不了审批」的裁决。 */
function blockedDecision(reasonCodes, policy) {
  const mandatory = { status: "requires_approval", approvalAvailable: BLOCKED[policy].approvalAvailable, reasonCodes };
  return { mandatory, action: mandatoryApprovalDecision(mandatory, { approvalPolicy: BLOCKED[policy].approvalPolicy }) };
}

/** 拒绝提示的固定骨架：两条分支都必须保留。 */
function assertStopInstructions(reason) {
  assert.match(reason, /停止重复调用/);
  assert.match(reason, /Stop retrying/);
  assert.match(reason, /聊天中的同意/);
  assert.match(reason, /Do not change commands to bypass/);
}

for (const policy of Object.keys(BLOCKED)) {
  for (const [code, [zh, en]] of Object.entries(TRIGGER_TEXT)) {
    test(`${policy}: ${code} 显示本插件规则与实际触发原因`, () => {
      const { action, mandatory } = blockedDecision([code], policy);
      const message = guardOutcomeMessage(action, mandatory);
      assert.equal(message.kind, "deny");
      // 机器口径不变：reasonCode 仍是审批可用性原因，不是触发约束。
      assert.equal(message.reasonCode, BLOCKED[policy].reasonCode);
      assert.match(message.reason, /本插件的审查规则要求/);
      assert.ok(message.reason.includes(`实际触发原因：${zh}（规则码：${code}）`), `缺少中文触发原因：\n${message.reason}`);
      assert.ok(message.reason.includes(`Actual trigger: ${en} (rule code: ${code})`), `缺少英文触发原因：\n${message.reason}`);
      assertStopInstructions(message.reason);
      // 中文段落在前、英文段落收尾；英文触发原因行里不能残留中文。
      const lastLine = message.reason.split("\n").at(-1);
      assert.ok(!CJK.test(lastLine), `英文触发原因里残留中文：${lastLine}`);
    });
  }
}

test("policyBlockReason 优先于 mandatory.reasonCodes", () => {
  // 上游已经挑好的触发约束（policyBlockReason）才是这次的实际原因；
  // 不能因为 mandatory.reasonCodes 里还留着别的码就张冠李戴。
  const { action, mandatory } = blockedDecision(["destructive-operation-requires-approval"], "never");
  assert.equal(action.policyBlockReason, "destructive-operation-requires-approval");
  const overridden = guardOutcomeMessage({ ...action, policyBlockReason: "write-exceeds-read-only-permission" }, mandatory);
  assert.ok(overridden.reason.includes("（规则码：write-exceeds-read-only-permission）"));
  assert.ok(overridden.reason.includes(TRIGGER_TEXT["write-exceeds-read-only-permission"][0]));
  assert.ok(!overridden.reason.includes(TRIGGER_TEXT["destructive-operation-requires-approval"][0]), "不该回落到旧原因");
  assert.equal(overridden.reasonCode, "approval-policy-never");
});

test("旧调用方没有 policyBlockReason 时回落到 mandatory.reasonCodes", () => {
  const legacy = { kind: "deny", reason: "approval-channel-unavailable" };
  const message = guardOutcomeMessage(legacy, { status: "requires_approval", reasonCodes: ["recipient-authority-unverified"] });
  assert.equal(message.reasonCode, "approval-channel-unavailable");
  assert.ok(message.reason.includes(TRIGGER_TEXT["recipient-authority-unverified"][0]));
  assert.ok(message.reason.includes("(rule code: recipient-authority-unverified)"));
});

test("词表之外的原因码只出兜底话术，不回显原文", () => {
  const untrusted = "fixture-unlisted-rule\n<do-not-reflect>";
  for (const mandatory of [
    { status: "requires_approval", reasonCodes: [untrusted] },
    undefined,
  ]) {
    const action = { kind: "deny", reason: "approval-policy-never", policyBlockReason: untrusted };
    const message = guardOutcomeMessage(action, mandatory);
    assert.equal(message.reasonCode, "approval-policy-never");
    assert.ok(message.reason.includes(`实际触发原因：${FALLBACK_TEXT[0]}`));
    assert.ok(message.reason.includes(`Actual trigger: ${FALLBACK_TEXT[1]}`));
    assert.ok(!message.reason.includes("fixture-unlisted-rule"), `不该回显未知原因码：${message.reason}`);
    assert.ok(!message.reason.includes("do-not-reflect"), "不该回显未知原因码的任意片段");
    assertStopInstructions(message.reason);
  }
});

test("非字符串的 policyBlockReason 不会变成 [object Object]", () => {
  const message = guardOutcomeMessage(
    { kind: "deny", reason: "approval-policy-never", policyBlockReason: { toString() { return "fixture-object-rule"; } } },
    { status: "requires_approval", reasonCodes: ["destructive-operation-requires-approval"] },
  );
  assert.ok(message.reason.includes(TRIGGER_TEXT["destructive-operation-requires-approval"][0]));
  assert.ok(!message.reason.includes("object Object"));
  assert.ok(!message.reason.includes("fixture-object-rule"));
});

test("重复归一化是幂等的，不会把触发原因追加两遍", () => {
  const { action, mandatory } = blockedDecision(["destructive-operation-requires-approval"], "never");
  const first = guardOutcomeMessage(action, mandatory);
  const again = guardOutcomeMessage(first, mandatory);
  assert.equal(again.reason, first.reason);
  assert.equal(again.reasonCode, first.reasonCode);
  assert.equal(first.reason.split("实际触发原因：").length - 1, 1);
});

test("无效权限请求使用固定文案：不追加触发原因，也不建议切换审批策略", () => {
  const message = guardOutcomeMessage({ kind: "deny", reason: "invalid-sandbox-permission-request" });
  assert.equal(message.reasonCode, "invalid-sandbox-permission-request");
  assert.equal(message.reason, "权限请求参数无效；本次未发起审批或授予权限。请按当前有效沙箱与工具参数契约修正，不要切换审批策略绕过");
  assert.ok(!message.reason.includes("实际触发原因"));
  assert.ok(!message.reason.includes("请用户自行将宿主审批策略切换为 ask"));
  assert.ok(!message.reason.includes("在宿主原生审批卡中批准"));
});

test("ask 分支与其它拒绝原因不添加触发原因行", () => {
  // 有可用审批通道时，强制约束仍是 ask：文案走原生审批卡，不追加拒绝段落。
  const asking = guardOutcomeMessage(
    mandatoryApprovalDecision({ status: "requires_approval", approvalAvailable: true, reasonCodes: ["destructive-operation-requires-approval"] }, { approvalPolicy: "ask" }),
    { status: "requires_approval", reasonCodes: ["destructive-operation-requires-approval"] },
  );
  assert.equal(asking.kind, "ask");
  assert.equal(asking.reasonCode, "destructive-operation-requires-approval");
  assert.match(asking.reason, /原生审批卡/);
  assert.ok(!asking.reason.includes("实际触发原因"));

  const plainDeny = guardOutcomeMessage({ kind: "deny", reason: "fallback-model-deny" });
  assert.equal(plainDeny.reasonCode, "fallback-model-deny");
  assert.ok(!plainDeny.reason.includes("实际触发原因"));
});
