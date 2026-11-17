import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createGuardFixture as fixture } from "./helpers/guard-fixture.js";
import { PLUGIN_VERSION } from "../lib/plugin-meta.js";

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

test("审批不可用时，本地已判安全的写操作直接交宿主，不再调用模型（审计 P1-2）", async () => {
  // 1.13.0 现场：mandatory=safe 的工作区 write/edit 因模型 medium/high 被
  // never 直接 deny。后来改成「仍调模型、但不许否决」；审计 11-16 进一步
  // 确认模型在 never + 非自动审查下既不能批准也不能阻止，失败反而会拒绝，
  // 所以 DEC-076 的「直接 delegate」现在落到代码里：不调主模型、不调回退。
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
      assert.equal(decision.kind, "allow", reviewAction);
      assert.equal(env.modelCalls, 0, "safe 写不再经过模型");
      assert.equal(env.fallbackCalls, 0, "也不进回退");
      assert.equal(env.records[0].audit.mandatory.status, "safe");
      assert.equal(env.records[0].audit.reasonCode, "safe-local-operation-host-sandbox");
      assert.equal(env.records[0].audit.decisionSource, "local_policy");
    } finally { await env.cleanup(); }
  }
});

test("never 下非 safe 回退失败仍 fail-closed", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    throwFallback: true,
    config: { tolerance: "default", guardFallback: "session" },
  });
  try {
    // 外部网络工具 → mandatory=unknown，不属于 safe 直通；回退失败必须拒绝。
    const { decision } = await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(decision.kind, "deny");
    assert.equal(env.fallbackCalls, 1);
  } finally { await env.cleanup(); }
});

test("never + safe：回退策略（allow/deny）不参与，直接交宿主", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "default", guardFallback: "allow" },
  });
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.fallbackCalls, 0, "safe 不进入回退链路");
    assert.equal(env.records[0].audit.decisionSource, "local_policy");
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
    const { decision } = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.fallbackCalls, 0, "档位已结案，不该再叫回退模型");
    assert.equal(env.records[0].audit.reasonCode, "tolerance-delegate");
  } finally { await env.cleanup(); }
});

test("never + autonomous 下 safe 写也不依赖模型意见", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "high",
    config: { tolerance: "autonomous", guardFallback: "session" },
  });
  try {
    const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.modelCalls, 0, "autonomous 也不能让模型覆盖 safe 宿主边界");
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.records[0].audit.reasonCode, "safe-local-operation-host-sandbox");
  } finally { await env.cleanup(); }
});

test("never 下 safe 写不依赖模型意见，high/注入设置也不会触发模型", async () => {
  // 审计 11-16 P1-2：本地规则已确认工作区内安全，模型在 never + 非自动
  // 审查下无法改变结论，失败反而会拒绝；因此连主模型都不再调用。
  for (const options of [{ choice: "high" }, { choice: "low", injection: 0.99 }]) {
    const env = await fixture({
      preset: "danger-full-access",
      approval: "never",
      ...options,
      reviewAction: "deny",
      config: { tolerance: "default", guardFallback: "session" },
    });
    try {
      const { decision } = await env.run("write", { file_path: "allowed.txt", content: "fixture" });
      assert.equal(decision.kind, "allow", JSON.stringify(options));
      assert.equal(env.modelCalls, 0, "safe 写不经过模型");
      assert.equal(env.fallbackCalls, 0, "safe 不进入回退链");
    } finally { await env.cleanup(); }
  }
});

test("never 下强制权限约束仍然在模型之前拒绝，回退不能替代批准", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "default", guardFallback: "allow", guardDeferOutsideWorkspace: false },
  });
  try {
    const { decision } = await env.run("write", { file_path: join(env.root, "..", "not-authorized.txt"), content: "fixture" });
    assert.equal(decision.kind, "deny");
    assert.equal(env.modelCalls, 0, "mandatory 在模型之前早退");
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.records[0].audit.mandatory.status, "requires_approval");
    assert.equal(env.records[0].audit.reasonCode, "approval-policy-never");
    assert.equal(env.records[0].audit.policyBlockReason, "write-outside-authorized-workspace");
  } finally { await env.cleanup(); }
});

test("mandatory先于auto、allow回退和所有tolerance，never阻止真实文件越界调用", async () => {
  for (const tolerance of ["default", "autonomous", "relaxed", "cautious"]) {
    const env = await fixture({ approval: "never", sandbox: "danger-full-access", config: { tolerance, guardFallback: "allow", guardDeferOutsideWorkspace: false } });
    try {
      const { decision } = await env.run("write", { file_path: join(env.root, "..", "not-authorized.txt"), content: "fixture" });
      assert.equal(decision.kind, "deny", tolerance);
      assert.equal(env.modelCalls, 0);
      assert.equal(env.sideEffects, 0);
      assert.equal(env.records[0].audit.mandatory.status, "requires_approval");
      assert.equal(env.records[0].audit.policyBlockReason, "write-outside-authorized-workspace", tolerance);
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
      assert.equal((await env.run("pwsh", { command: "node fixture.js", sandbox_permissions: "danger-full-access", justification: "fixture-only: confirm escalation is not softened by model failure" })).decision.kind, "deny");
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
    const { decision, exec } = await env.run("pwsh", { command: "node fixture.js", sandbox_permissions: "danger-full-access", justification: "fixture-only: verify the approval grant is bound to this exact call" });
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

test("同会话同参重复调用在 120 秒内复用首次裁决（审计 P0-2）", async () => {
  // safe 写现在不走模型，记忆要用仍会问模型的 unknown 命令来验证。
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "default", guardFallback: "session" },
  });
  try {
    const first = await env.run("pwsh", { command: "node fixture.js" });
    const second = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(first.decision.kind, "allow");
    assert.equal(second.decision.kind, "allow", "同参数重试不应得到相反结论");
    assert.equal(env.modelCalls, 1, "第二次应复用首次裁决，不再调用模型");
    assert.equal(env.fallbackCalls, 1, "回退裁决被复用，不再走第二模型");
    assert.equal(env.records[1].audit.reused, true);
    // 复用记录必须保留原始来源与稳定 reasonCode：否则统计会把模型裁决记成
    // 本地规则，reasonCode 还可能落成 unclassified（2026-11-16 审计 P0-1）。
    assert.equal(env.records[1].audit.reasonCode, env.records[0].audit.reasonCode);
    assert.equal(env.records[1].audit.decisionSource, env.records[0].audit.decisionSource);
    assert.notEqual(env.records[1].audit.decisionSource, "local_policy");
    assert.equal(env.records[1].audit.modelEvaluation.status, "completed");
    assert.equal(env.records[1].audit.cacheStatus, "hit");
  } finally { await env.cleanup(); }
});

test("复用模型低风险裁决时保留 reasonCode 与来源（审计 P0-1 现场）", async () => {
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "low",
    config: { tolerance: "default", guardFallback: "session" },
  });
  try {
    await env.run("mcp__fixture__query", { query: "fixture" });
    await env.run("mcp__fixture__query", { query: "fixture" });
    assert.equal(env.modelCalls, 1, "第二次复用，不再调模型");
    const record = env.records[1].audit;
    assert.equal(record.reused, true);
    assert.equal(record.reasonCode, "model-low-risk-advisory");
    assert.notEqual(record.reasonCode, "unclassified");
    assert.equal(record.decisionSource, "primary_model");
    assert.equal(record.modelEvaluation.status, "completed");
    assert.equal(record.cacheStatus, "hit");
  } finally { await env.cleanup(); }
});

test("模型失败不缓存，服务恢复后同参重新审查", async () => {
  const options = {
    preset: "danger-full-access",
    approval: "never",
    throwModel: true,
    choice: "low",
    config: { tolerance: "default", guardFallback: "session" },
  };
  const env = await fixture(options);
  try {
    const first = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(first.decision.kind, "deny");
    assert.equal(env.records[0].audit.modelEvaluation.status, "failed");
    assert.equal(env.records[0].audit.reasonCode, "advisory-failed-unknown-effect");
    options.throwModel = false;
    const second = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(second.decision.kind, "allow");
    assert.equal(env.modelCalls, 2, "恢复后必须重新调用模型");
    assert.equal(env.records[1].audit.reused, false);
    assert.equal(env.records[1].audit.modelEvaluation.status, "completed");
    assert.equal(env.records[1].audit.reasonCode, "model-low-risk-advisory");
    assert.equal(env.records[1].audit.cacheStatus, "miss");
  } finally { await env.cleanup(); }
});

test("阶段拆分后复用裁决保留版本、回退、基础动作和下游拒绝", async () => {
  for (const options of [
    { guardFallback: "session", reviewAction: "allow", expected: "allow" },
    { guardFallback: "session", reviewAction: "deny", expected: "deny" },
    { guardFallback: "allow", expected: "allow" },
    { guardFallback: "deny", expected: "deny" },
  ]) {
    const env = await fixture({ approval: "never", choice: "medium", reviewAction: options.reviewAction, config: { tolerance: "default", guardFallback: options.guardFallback } });
    try {
      const args = { query: "fixture-pipeline" };
      const first = await env.run("mcp__fixture__query", args);
      const second = await env.run("mcp__fixture__query", args);
      assert.equal(first.decision.kind, options.expected);
      assert.equal(second.decision.kind, options.expected);
      assert.equal(env.modelCalls, 1);
      assert.equal(env.fallbackCalls, options.guardFallback === "session" ? 1 : 0);
      const original = env.records[0].audit;
      const reused = env.records[1].audit;
      assert.equal(reused.pluginVersion, PLUGIN_VERSION);
      assert.equal(reused.pluginVersion, original.pluginVersion);
      assert.equal(reused.reused, true);
      assert.equal(reused.cacheStatus, "hit");
      assert.equal(reused.reasonCode, original.reasonCode);
      assert.equal(reused.decisionSource, original.decisionSource);
      assert.equal(reused.baseAction, "ask");
      assert.deepEqual(reused.fallback, original.fallback);
      assert.equal(reused.fallback.fallback, options.guardFallback);
      assert.equal(reused.modelEvaluation.primary.status, "cache_hit");
      assert.equal(reused.mandatory.status, "unknown");
      assert.equal(Boolean(env.guard(second.exec)), options.expected === "deny");
    } finally { await env.cleanup(); }
  }
});

test("阶段拆分不让可用审批通道复用旧裁决", async () => {
  const env = await fixture({ preset: "custom", approval: "ask", choice: "low" });
  try {
    await env.run("mcp__fixture__query", { query: "fixture-pipeline" });
    await env.run("mcp__fixture__query", { query: "fixture-pipeline" });
    assert.equal(env.modelCalls, 2);
    assert.equal(env.records[1].audit.reused, false);
    assert.equal(env.records[1].audit.cacheStatus, "miss");
    assert.equal(env.records[1].audit.reasonCode, env.records[0].audit.reasonCode);
  } finally { await env.cleanup(); }
});

test("档位放行的 reasonCode 是稳定枚举，档位 note 只进 humanReason（审计 P0-3）", async () => {
  // relaxed + medium：严重度 0.5 < 冷启动 0.6 → 档位把 ask 降成 delegate。
  const env = await fixture({
    preset: "danger-full-access",
    approval: "never",
    choice: "medium",
    config: { tolerance: "relaxed", guardFallback: "session" },
  });
  try {
    const { decision } = await env.run("pwsh", { command: "node fixture.js" });
    assert.equal(decision.kind, "allow");
    const record = env.records[0].audit;
    assert.equal(record.reasonCode, "tolerance-delegate");
    assert.doesNotMatch(record.reasonCode, /[\u4e00-\u9fff]/, "reasonCode 不能是中文长句");
    assert.match(record.humanReason, /tolerance=relaxed/);
  } finally { await env.cleanup(); }
});
