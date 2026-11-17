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

test("越级、降级、只读、未知上下文与非法字段保持提权保护", () => {
  const cases = [
    [WS, FULL], [FULL, WS], ["read-only", WS], ["read-only", FULL], ["unknown", FULL], [undefined, WS],
  ];
  for (const [ctxMode, requested] of cases) {
    const context = { sandboxMode: ctxMode, fileTargetScope: "inside" };
    const { effect, mandatory } = judge("write", { ...writeArgs, sandbox_permissions: requested }, context);
    assert.equal(effect.kind, "privileged", `${ctxMode}->${requested}`);
    assert.equal(mandatory.status, "requires_approval");
  }
  for (const bad of ["read-only", "bogus", "", 1, true, null, {}, []]) {
    assert.equal(judge("write", { ...writeArgs, sandbox_permissions: bad }, inside(FULL)).effect.kind, "privileged", String(bad));
  }
  for (const justification of [1, null, {}, false]) {
    assert.equal(judge("write", { ...writeArgs, sandbox_permissions: FULL, justification }, inside(FULL)).effect.kind, "privileged");
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

test("pwsh 需非空说明才归一化；合法 pwsh/bash 同级仍不被放行", () => {
  const ctx = { sandboxMode: FULL };
  for (const justification of [undefined, "", "   ", 1]) {
    const args = { command: "node fixture.js", sandbox_permissions: FULL, ...(justification === undefined ? {} : { justification }) };
    assert.equal(judge("pwsh", args, ctx).effect.kind, "privileged", String(justification));
  }
  for (const tool of ["pwsh", "bash"]) {
    const { effect, mandatory } = judge(tool, { command: "node fixture.js", sandbox_permissions: FULL, justification: "why" }, ctx);
    assert.notEqual(effect.kind, "privileged", tool);
    assert.equal(mandatory.status, "unknown", "不是 safe，仍交审查");
  }
  assert.equal(judge("bash", { command: "node fixture.js", sandbox_permissions: FULL }, ctx).effect.kind, "unknown");
  assert.equal(judge("pwsh", { command: "Get-Location", sandbox_permissions: FULL, justification: "why" }, { ...ctx, ...{ shellExecution: { freshProcess: true, noProfile: true } } }).mandatory.status, "safe");
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

test("listener：越级、越界、未知工具与危险命令仍被拒", async () => {
  const env = await createGuardFixture({ sandbox: WS, preset: WS, approval: "never", config: { guardFallback: "allow", guardDeferOutsideWorkspace: false } });
  try {
    assert.equal((await env.run("write", { ...writeArgs, sandbox_permissions: FULL })).decision.kind, "deny");
    assert.equal((await env.run("pwsh", { command: "node fixture.js", sandbox_permissions: WS })).decision.kind, "deny", "pwsh 缺说明");
    assert.equal((await env.run("shell", { command: "fixture", sandbox_permissions: WS, justification: "x" })).decision.kind, "deny");
    assert.equal((await env.run("pwsh", { command: "sudo fixture", sandbox_permissions: WS, justification: "x" })).decision.kind, "deny");
    assert.equal((await env.run("pwsh", { command: "Remove-Item fixture", sandbox_permissions: WS, justification: "x" })).decision.kind, "deny");
    assert.equal((await env.run("write", { file_path: join(env.root, "..", "x.txt"), content: "f", sandbox_permissions: WS })).decision.kind, "deny");
    assert.equal(env.sideEffects, 0);
  } finally { await env.cleanup(); }
  const ro = await createGuardFixture({ sandbox: "read-only", preset: "read-only", approval: "never" });
  try {
    assert.equal((await ro.run("write", { ...writeArgs, sandbox_permissions: WS })).decision.kind, "deny");
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
