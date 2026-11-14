import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createGuardFixture as fixture } from "./helpers/guard-fixture.js";

test("auto依旧查询决策模型，软性人工决定交会话LLM而非跳过", async () => {
  const env = await fixture();
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.modelCalls, 1);
    assert.equal(env.fallbackCalls, 1);
    assert.equal(await readFile(join(env.root, "allowed.txt"), "utf8"), "fixture-only");
  } finally { await env.cleanup(); }
});

test("mandatory先于auto、allow回退和所有tolerance，never阻止真实文件越界调用", async () => {
  for (const tolerance of ["default", "autonomous", "relaxed", "cautious"]) {
    const env = await fixture({ approval: "never", sandbox: "danger-full-access", config: { tolerance, guardFallback: "allow" } });
    try {
      const { decision } = await env.run("write", { file_path: join(env.root, "..", "not-authorized.txt"), content: "fixture" });
      assert.equal(decision.kind, "deny", tolerance);
      assert.equal(env.modelCalls, 0);
      assert.equal(env.sideEffects, 0);
      assert.equal(env.records[0].audit.mandatory.status, "requires_approval");
    } finally { await env.cleanup(); }
  }
});

test("known查询、任务板和同tree委派不受模型误报影响，不触发网络审核", async () => {
  const env = await fixture({ choice: "high", injection: 1 });
  try {
    const calls = [["list_agents", {}], ["todo_write", { todos: [{ content: "fixture", status: "completed" }] }], ["team_task_update", { task_id: "fixture", expected_revision: 1, action: "complete" }], ["send_message", { agent: "reviewer", message: "Review this change, do not run any tools." }]];
    for (const [name, args] of calls) assert.equal((await env.run(name, args)).decision.kind, "allow", name);
    assert.equal(env.modelCalls, 0);
  } finally { await env.cleanup(); }
});

test("畸形模型、异常和缺host权限不会静默放行高影响工具", async () => {
  for (const options of [{ throwModel: true }, { degraded: true }]) {
    const env = await fixture({ ...options, approval: "never", config: { guardFallback: "allow" } });
    try {
      assert.equal((await env.run("pwsh", { command: "node fixture.js" })).decision.kind, "deny");
      assert.equal(env.sideEffects, 0);
    } finally { await env.cleanup(); }
  }
});

test("可审查工作区写入的模型异常仍遵守选定Fallback而非catch自动放行", async () => {
  for (const guardFallback of ["deny", "session"]) {
    const env = await fixture({ throwModel: true, config: { guardFallback } });
    try {
      const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
      assert.equal(decision.kind, guardFallback === "deny" ? "deny" : "allow");
      assert.equal(env.fallbackCalls, guardFallback === "deny" ? 0 : 1);
    } finally { await env.cleanup(); }
  }
});

test("手动模式medium低confidence仍询问，任务高相关真注入不豁免",  async () => {
  const env = await fixture({ preset: "custom", choice: "low", injection: 0.99 });
  try {
    assert.equal((await env.run("write", { file_path: "allowed.txt", content: "fixture" })).decision.kind, "ask");
    assert.equal(env.sideEffects, 0);
  } finally { await env.cleanup(); }
});

test("waterfall把ask改成allow也必须有本次宿主allowed-once，不能把available当授权", async () => {
  const env = await fixture({ approval: "ask" });
  try {
    const { decision, exec } = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(decision.kind, "ask");
    assert.ok(env.guard(exec), "没有本次approval grant必须拒绝，即便其他wrapper返回allow");
    env.approvalEvents.push({ type: "approval/asked", seq: 2, data: { id: "wrong", callId: "other-call", toolName: "pwsh" } }, { type: "approval/decided", seq: 3, data: { id: "wrong", outcome: "allowed-once" } });
    assert.ok(env.guard(exec), "别的call grant不能复用");
    env.approvalEvents.push({ type: "approval/asked", seq: 4, data: { id: "right", callId: exec.callId, toolName: "pwsh" } }, { type: "approval/decided", seq: 5, data: { id: "right", outcome: "allowed-once" } });
    assert.equal(env.guard(exec), undefined);
    const changed = { ...exec, arguments: { command: "node different-fixture.js" } };
    assert.ok(env.guard(changed), "本次grant也不能给变更后的参数使用");
  } finally { await env.cleanup(); }
});

test("host reported-success与插件返回defer分开，不能伪装副作用已验证",  async () => {
  const env = await fixture();
  try {
    const { exec } = await env.run("list_agents", {});
    env.hooks.get("tools/result")(exec, { isError: false, value: [], content: [] });
    await Promise.resolve();
    const final = env.records.at(-1).audit;
    assert.equal(final.pluginReturnedAction, "defer_to_host");
    assert.equal(final.effectOutcome, "reported-success");
    assert.equal(final.hostFinalAction, "unknown");
    assert.equal(final.hostApprovalStatus, "unknown");
    assert.doesNotMatch(JSON.stringify(final), /Only edit fixture|user approved everything/);
  } finally { await env.cleanup(); }
});
