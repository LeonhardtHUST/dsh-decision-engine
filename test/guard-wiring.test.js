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

test("审批通道不存在（never）时，软性询问交给 guardFallback，而不是静默 deny", async () => {
  // 实机缺陷（1.11.2 之前）：automaticReview 只认 permissionPreset === "auto"。
  // 预设名是部署可配置的（read-only / workspace-write / danger-full-access），
  // 用户配置 danger-full-access + never 时 auto 永远不出现，于是模型判 medium
  // 的软 ask 被直接改成 deny，配置好的 guardFallback 完全没被使用。
  for (const reviewAction of ["allow", "deny"]) {
    const env = await fixture({
      preset: "danger-full-access",
      approval: "never",
      choice: "medium",
      reviewAction,
      config: { tolerance: "default", guardFallback: "session" },
    });
    try {
      const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
      assert.equal(decision.kind, reviewAction === "allow" ? "allow" : "deny", reviewAction);
      assert.equal(env.modelCalls, 1, "主模型仍然给出自己的建议");
      assert.equal(env.fallbackCalls, 1, "没有真人可问时应交给回退审查者");
      assert.equal(env.records[0].audit.decisionSource, "fallback_model");
      assert.equal(env.records[0].audit.mandatory.status, "safe");
    } finally { await env.cleanup(); }
  }
});

test("never 下回退审查者失败仍 fail-closed", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    throwFallback: true,
    config: { tolerance: "default", guardFallback: "session" },
  });
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "deny");
    assert.equal(env.fallbackCalls, 1);
  } finally { await env.cleanup(); }
});

test("never + 显式 allow 回退策略放行软性询问，且不额外调用模型", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "default", guardFallback: "allow" },
  });
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.fallbackCalls, 0, "策略本身就是裁决，不该再叫模型");
    assert.equal(env.records[0].audit.decisionSource, "fallback_policy");
  } finally { await env.cleanup(); }
});

test("never + 少问档：medium 未达尾部时由档位直接降为放行", async () => {
  // 少问是「替换」语义：严重度 0.5（medium）< 冷启动 0.60 时，档位直接把
  // ask 降成 delegate，既不弹窗也不 deny、也不必叫回退模型。
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "relaxed", guardFallback: "session" },
  });
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.fallbackCalls, 0, "档位已结案，不该再叫回退模型");
  } finally { await env.cleanup(); }
});

test("never 下高危与注入嫌疑不被回退软化", async () => {
  // 高危 / 注入是硬性询问，不接受「再问一个模型」；即使用户配置了
  // session 回退，也必须保持 deny。
  for (const options of [{ choice: "high" }, { choice: "low", injection: 0.99 }]) {
    const env = await fixture({
      preset: "danger-full-access",
      approval: "never",
      ...options,
      reviewAction: "allow",
      config: { tolerance: "default", guardFallback: "session" },
    });
    try {
      const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
      assert.equal(decision.kind, "deny", JSON.stringify(options));
      assert.equal(env.fallbackCalls, 0, "高危/注入不进入回退链");
    } finally { await env.cleanup(); }
  }
});

test("never 下强制权限约束仍然在模型之前拒绝，回退不能替代批准", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "default", guardFallback: "allow" },
  });
  try {
    const { decision } = await env.run("write", { file_path: join(env.root, "..", "not-authorized.txt"), content: "fixture" });
    assert.equal(decision.kind, "deny");
    assert.equal(env.modelCalls, 0, "mandatory 在模型之前早退");
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.records[0].audit.mandatory.status, "requires_approval");
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

test("模型异常或显式allow回退不能放行已确认的权限升级",  async () => {
  for (const options of [{ throwModel: true }, { degraded: true }]) {
    const env = await fixture({ ...options, approval: "never", config: { guardFallback: "allow" } });
    try {
      assert.equal((await env.run("pwsh", { command: "node fixture.js", sandbox_permissions: "danger-full-access" })).decision.kind, "deny");
      assert.equal(env.sideEffects, 0);
    } finally { await env.cleanup(); }
  }
});

test("可审查工作区写入的模型异常仍遵守选定Fallback而非catch自动放行", async () => {
  for (const guardFallback of ["deny", "session"]) {
    const env = await fixture({ throwModel: true, config: { guardFallback } });
    try {
      const { decision, exec } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
      assert.equal(decision.kind, guardFallback === "deny" ? "deny" : "allow");
      if (guardFallback === "deny") assert.ok(env.guard(exec), "配置的拒绝也不能被后续wrapper覆盖");
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
    const { decision, exec } = await env.run("pwsh", { command: "node fixture.js", sandbox_permissions: "danger-full-access" });
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

test("auto下本地未知副作用的低风险放行只走主模型，不再为mandatory=unknown二次复核", async () => {
  // pwsh 的命令内容无法静态判定（effect.kind=unknown, known=false），mandatory 因此
  // 是 unknown；但主模型给出了有效低风险意见、档位也没升级询问。此时回退一次意味着
  // 每条本地命令稳定多花一次模型调用——这正是要去掉的冗余。
  const env = await fixture({ choice: "low" });
  try {
    const { decision } = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.modelCalls, 1);
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.records[0].audit.mandatory.status, "unknown", "不确定性仍照实记录");
    assert.equal(env.records[0].audit.decisionSource, "primary_model");
    assert.equal(env.records[0].audit.pluginReturnedAction, "defer_to_host");
    assert.equal(env.sideEffects, 1);
  } finally { await env.cleanup(); }
});

test("显式deny回退策略不被本地未知豁免绕过", async () => {
  // 豁免只针对「再叫一个模型复核」（session / model）。显式 deny 是用户写下的
  // 政策裁决：它不需要模型调用，但结论必须照旧生效，否则豁免就成了绕过开关。
  const env = await fixture({ choice: "low", config: { guardFallback: "deny" } });
  try {
    const { decision, exec } = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(decision.kind, "deny");
    assert.equal(env.fallbackCalls, 0, "deny 策略本身不需要模型调用");
    assert.equal(env.records[0].audit.decisionSource, "fallback_policy");
    assert.equal(env.records[0].audit.mandatory.status, "unknown");
    assert.equal(env.sideEffects, 0);
    assert.ok(env.guard(exec), "下游仍须拒绝：策略拒绝不是放行");
  } finally { await env.cleanup(); }
});

test("中风险ask仍二次复核，本地未知豁免不覆盖软性询问", async () => {
  // 模型判 medium → baseAction=ask。ask 是「需要再看一眼」的软性判断，与
  // 「静态规则不知道副作用」是两件事，豁免不能把它一起省掉。
  const env = await fixture({ choice: "medium" });
  try {
    const { decision } = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.modelCalls, 1);
    assert.equal(env.fallbackCalls, 1, "medium 仍需独立复核");
    assert.equal(env.records[0].audit.baseAction, "ask");
    assert.equal(env.records[0].audit.decisionSource, "fallback_model");
  } finally { await env.cleanup(); }
});
