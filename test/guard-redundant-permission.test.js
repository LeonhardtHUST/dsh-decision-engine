import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifyToolEffect } from "../lib/guard/effects.js";
import { evaluateMandatoryPolicy } from "../lib/guard/policy.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const FULL = "danger-full-access";
const WS = "workspace-write";

function judge(toolName, args, context) {
  const effect = classifyToolEffect({ toolName, args, trustedContext: context });
  return { effect, mandatory: evaluateMandatoryPolicy({ context, effect }) };
}

const inside = (sandboxMode) => ({ sandboxMode, fileTargetScope: "inside" });
const writeArgs = { file_path: "allowed.txt", content: "fixture" };
const editArgs = { file_path: "allowed.txt", old_string: "a", new_string: "b" };

test("同级声明对 write/edit 归一化后仅按普通工作区写入判定", () => {
  for (const mode of [FULL, WS]) {
    for (const [tool, base] of [["write", writeArgs], ["edit", editArgs]]) {
      for (const extra of [{}, { justification: "same mode" }]) {
        const args = { ...base, sandbox_permissions: mode, ...extra };
        assert.equal(judge(tool, args, inside(mode)).mandatory.status, "safe", `${tool}/${mode}`);
        assert.equal(judge(tool, args, { sandboxMode: mode }).mandatory.status, "unknown", "无 scope 证据不是 safe");
        assert.equal(judge(tool, args, { sandboxMode: mode, fileTargetScope: "outside" }).mandatory.status, "requires_approval");
      }
    }
  }
});

test("真正越级仍按提权保护；降级、缺说明与未知模式不被静默降档", () => {
  // 严格更宽才是审批候选。full 没有更宽模式，full→workspace-write 是降级请求，
  // 宿主判 SANDBOX_ESCALATION_INVALID_ARGUMENT；本地归 invalid_request。
  for (const [ctxMode, requested] of [[WS, FULL], ["read-only", WS], ["read-only", FULL]]) {
    const context = { sandboxMode: ctxMode, fileTargetScope: "inside" };
    for (const [tool, base] of [["write", writeArgs], ["edit", editArgs]]) {
      const { effect, mandatory } = judge(tool, { ...base, sandbox_permissions: requested, justification: "fixture: real escalation" }, context);
      assert.equal(effect.kind, "privileged", `${tool} ${ctxMode}->${requested}`);
      assert.equal(mandatory.status, "requires_approval");
    }
  }
  for (const justification of [undefined, "fixture: narrower request"]) {
    const { effect, mandatory } = judge("write", { ...writeArgs, sandbox_permissions: WS, ...(justification === undefined ? {} : { justification }) }, inside(FULL));
    assert.equal(effect.kind, "invalid_request");
    assert.equal(effect.known, true);
    assert.equal(effect.highImpact, true);
    assert.deepEqual(effect.reasonCodes, ["invalid-sandbox-permission-request"]);
    assert.equal(mandatory.status, "deny");
    assert.deepEqual(mandatory.reasonCodes, ["invalid-sandbox-permission-request"]);
  }
  // 有效 mode 未知：合法越级请求既不能归一化也不能被推断成降级，仍要提权保护。
  for (const ctxMode of ["unknown", undefined]) {
    const { effect, mandatory } = judge("write", { ...writeArgs, sandbox_permissions: FULL, justification: "fixture: unknown current mode" }, { sandboxMode: ctxMode, fileTargetScope: "inside" });
    assert.equal(effect.kind, "privileged", String(ctxMode));
    assert.equal(mandatory.status, "requires_approval");
  }
  // 显式非 same 时，缺说明/空说明/非字符串说明都在宿主上游判 invalid。
  for (const extra of [{}, { justification: "" }, { justification: "   " }, { justification: 1 }, { justification: null }]) {
    const { effect, mandatory } = judge("write", { ...writeArgs, sandbox_permissions: FULL, ...extra }, inside(WS));
    assert.equal(effect.kind, "invalid_request", JSON.stringify(extra));
    assert.equal(mandatory.status, "deny");
  }
});

test("非法枚举/类型与同级非法说明归无效请求，不冒充可审批提权", () => {
  for (const bad of ["read-only", "bogus", "", 1, true, null, {}, []]) {
    const { effect, mandatory } = judge("write", { ...writeArgs, sandbox_permissions: bad }, inside(FULL));
    assert.equal(effect.kind, "invalid_request", String(bad));
    assert.equal(mandatory.status, "deny");
    assert.deepEqual(mandatory.reasonCodes, ["invalid-sandbox-permission-request"]);
  }
  for (const justification of [1, null, {}, false]) {
    const { effect } = judge("write", { ...writeArgs, sandbox_permissions: FULL, justification }, inside(FULL));
    assert.equal(effect.kind, "invalid_request", String(justification));
  }
});

test("未知工具即使同级也保持提权；额外未知键不能变 safe", () => {
  for (const tool of ["shell", "apply_patch", "internal", "read", "skill", "job_output", "mcp__x__y", "future_tool"]) {
    assert.equal(judge(tool, { name: "x", job_id: "j", input: "p", sandbox_permissions: FULL }, inside(FULL)).effect.kind, "privileged", tool);
  }
  const extra = judge("write", { ...writeArgs, sandbox_permissions: FULL, surprise: 1 }, inside(FULL));
  assert.notEqual(extra.mandatory.status, "safe");
  assert.equal(extra.mandatory.status, "unknown");
});

test("pwsh 同模式也必须带非空说明；write/edit/bash 同模式可省说明", () => {
  const ctx = { sandboxMode: FULL };
  // pwsh 在 approve 之前无条件校验说明：同模式也不接受缺/空/非字符串说明。
  for (const justification of [undefined, "", "   ", 1]) {
    const args = { command: "node fixture.js", sandbox_permissions: FULL, ...(justification === undefined ? {} : { justification }) };
    const { effect, mandatory } = judge("pwsh", args, ctx);
    assert.equal(effect.kind, "invalid_request", String(justification));
    assert.equal(mandatory.status, "deny");
  }
  // fs 的 write/edit 同模式（宿主先做 no-op）可以省略说明，仍按普通工作区写入判定。
  for (const [tool, base] of [["write", writeArgs], ["edit", editArgs]]) {
    assert.equal(judge(tool, { ...base, sandbox_permissions: FULL }, inside(FULL)).mandatory.status, "safe", tool);
  }
  // bash 与 fs 一样：同模式可省说明，命令是否安全仍由静态契约决定。
  assert.equal(judge("bash", { command: "node fixture.js", sandbox_permissions: FULL }, ctx).effect.kind, "unknown");
  // 显式非 same：缺说明是无效请求，带合法说明才是真正提权。
  assert.equal(judge("bash", { command: "node fixture.js", sandbox_permissions: FULL }, { sandboxMode: WS }).effect.kind, "invalid_request");
  assert.equal(judge("bash", { command: "node fixture.js", sandbox_permissions: FULL, justification: "fixture" }, { sandboxMode: WS }).effect.kind, "privileged");
  // 合法 pwsh 同模式请求归一化后继续按命令契约判定；只读命令仍可 safe。
  assert.equal(judge("pwsh", { command: "Get-Location", sandbox_permissions: FULL, justification: "why" }, { ...ctx, ...{ shellExecution: { freshProcess: true, noProfile: true } } }).mandatory.status, "safe");
  assert.notEqual(judge("pwsh", { command: "node fixture.js", sandbox_permissions: FULL, justification: "why" }, ctx).effect.kind, "privileged");
});

test("同级声明下真实 sudo/ACL/删除命令仍需审批（仅 fixture，不执行）", () => {
  for (const tool of ["pwsh", "bash"]) {
    for (const [command, kind] of [["sudo fixture", "privileged"], ["icacls fixture", "privileged"], ["Remove-Item fixture", "destructive"], ["rm fixture", "destructive"]]) {
      const { effect, mandatory } = judge(tool, { command, sandbox_permissions: FULL, justification: "why" }, { sandboxMode: FULL });
      assert.equal(effect.kind, kind, `${tool}:${command}`);
      assert.equal(mandatory.status, "requires_approval");
    }
  }
});

test("原始参数不被修改（冻结对象也安全）", () => {
  const args = Object.freeze({ ...writeArgs, sandbox_permissions: FULL, justification: "same" });
  const snapshot = structuredClone(args);
  judge("write", args, inside(FULL));
  assert.deepEqual(args, snapshot);
  assert.equal(args.sandbox_permissions, FULL);
});

test("listener：fullaccess+never+enforce 的同级 write/edit 直接交宿主，不调模型或回退", async () => {
  for (const [tool, base] of [["write", writeArgs], ["edit", editArgs]]) {
    for (const mode of [FULL, WS]) {
      const env = await createGuardFixture({ sandbox: mode, preset: mode, approval: "never", config: { tolerance: "default", guardFallback: "session" } });
      try {
        const args = { ...base, sandbox_permissions: mode, justification: "same mode" };
        const { decision } = await env.run(tool, args);
        assert.equal(decision.kind, "allow", `${tool}/${mode}`);
        assert.equal(env.modelCalls, 0);
        assert.equal(env.fallbackCalls, 0);
        assert.equal(env.records[0].audit.mandatory.status, "safe");
      } finally { await env.cleanup(); }
    }
  }
});

test("listener：越级、无效请求、越界、未知工具与危险命令仍被拒", async () => {
  const env = await createGuardFixture({ sandbox: WS, preset: WS, approval: "never", config: { guardFallback: "allow", guardDeferOutsideWorkspace: false } });
  try {
    // 真正的越级仍走权限升级 → never 下按审批不可用拒绝。
    const escalation = await env.run("write", { ...writeArgs, sandbox_permissions: FULL, justification: "fixture: real escalation" });
    assert.equal(escalation.decision.kind, "deny");
    assert.equal(escalation.decision.info.code, "DECISION_ENGINE_APPROVAL_DISABLED");
    // 缺说明的越级是无效请求：本地拒绝，不发审批也不调模型。
    const invalid = await env.run("write", { ...writeArgs, sandbox_permissions: FULL });
    assert.equal(invalid.decision.kind, "deny");
    assert.equal(invalid.decision.info.code, "DECISION_ENGINE_INVALID_PERMISSION_REQUEST");
    assert.equal(invalid.decision.info.reason, "invalid-sandbox-permission-request");
    assert.deepEqual(env.records.at(-1).audit.mandatory.reasonCodes, ["invalid-sandbox-permission-request"]);
    assert.equal((await env.run("pwsh", { command: "node fixture.js", sandbox_permissions: WS })).decision.kind, "deny", "pwsh 同模式缺说明无效");
    assert.equal((await env.run("shell", { command: "fixture", sandbox_permissions: WS, justification: "x" })).decision.kind, "deny");
    assert.equal((await env.run("pwsh", { command: "sudo fixture", sandbox_permissions: WS, justification: "x" })).decision.kind, "deny");
    assert.equal((await env.run("pwsh", { command: "Remove-Item fixture", sandbox_permissions: WS, justification: "x" })).decision.kind, "deny");
    assert.equal((await env.run("write", { file_path: join(env.root, "..", "x.txt"), content: "f", sandbox_permissions: WS })).decision.kind, "deny");
    assert.equal(env.modelCalls, 0);
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.sideEffects, 0);
  } finally { await env.cleanup(); }
  const ro = await createGuardFixture({ sandbox: "read-only", preset: "read-only", approval: "never" });
  try {
    assert.equal((await ro.run("write", { ...writeArgs, sandbox_permissions: WS, justification: "fixture: read-only escalation" })).decision.kind, "deny");
    assert.equal(ro.sideEffects, 0);
  } finally { await ro.cleanup(); }
});

test("listener：observe/off 模式交给宿主，不因同级字段改变", async () => {
  for (const mode of ["observe", "off"]) {
    const env = await createGuardFixture({ sandbox: FULL, approval: "never", config: { mode, pointAuthorize: mode } });
    try {
      const { decision } = await env.run("write", { ...writeArgs, sandbox_permissions: FULL });
      assert.notEqual(decision.kind, "deny", mode);
    } finally { await env.cleanup(); }
  }
});
