/**
 * 分派 / 轮次 / 压缩三个 agent 决策点的**接线**测试（审计补强）。
 *
 * 与 spec.test.js 的分工：那边测「判断本身」，这里测「现场证据是不是真的」——
 * 审计里控诉的正是这一层：state 里塞的是硬编码 0、没有用户目标、把插件自己
 * 注入的消息当成新任务、以及 compact 只要一个概率就敢做不可逆裁剪。
 *
 * 全部用假的 client / cfg / ctx / session 与事件数组：不打网络，不碰真实
 * session，`steer` 只是往一个数组里塞消息。
 *
 * 事件形状以宿主实测为准（DSH 0.2.x）：
 *   user/message   data = { role, content, source }（也可能包一层 data.message）
 *   tool/call      data = { callId, name, arguments }
 *   tool/result    data = { message: { role, toolCallId, content } }
 *
 * 运行：node --test test/agent-points.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createDecisionRunner } from "../lib/engine.js";
import { POINT_SPECS } from "../lib/points/spec.js";
import { mountAgentPoints } from "../lib/adapters/agent.js";

/** 配置基线（与 index.js 的 DEFAULTS 对齐）。 */
const baseCfg = (over = {}) => ({
  mode: "shadow",
  recentMessages: 0,
  recentMessageChars: 240,
  delegateConfidenceFloor: 0.5,
  delegateBlockingFloor: 0.6,
  delegateParallelFloor: 0.5,
  compactContextWindow: 100000,
  compactThresholdRatio: 0.7,
  compactTriggerTokens: 100000,
  compactToolResultChars: 8192,
  compactDistilledFloor: 0.6,
  compactVerbatinFloor: 0.6,
  // 默认与 DEFAULTS 一致：不允许只裁剪、跳过摘要。
  compactAllowPrune: false,
  turnStopMaxSteers: 1,
  turnStopClosedFloor: 0.6,
  turnStopUnfinishedFloor: 0.6,
  turnStopValueFloor: 0.35,
  turnStopAwaitingUserFloor: 0.5,
  ...over,
});

/** 构造一条 noul 答案。 */
const noul = (value) => ({ type: "noul", noul: value });

/** 构造一条 choice 答案。 */
const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence, probabilities: {} });

/** turnStop 的「收束」答案（不带 awaiting_user：边界未知时也必须收束）。 */
const stopAnswers = {
  unfinished: noul(0.1),
  value: noul(0.1),
  closed: noul(0.9),
};

/** 造一个 runner（真实的 createDecisionRunner，假的 client）。 */
function makeRunner({ modes = {}, classify, cfg = baseCfg() } = {}) {
  const calls = [];
  const entries = [];
  const client = {
    async classify(call) {
      calls.push(call);
      return classify === undefined ? null : classify(call);
    },
  };
  const runner = createDecisionRunner({
    getConfig: () => cfg,
    client,
    logger: { warn() {}, info() {} },
    modeOf: (current, id) => modes[id] ?? "off",
    log: async (entry) => entries.push(entry),
    specOf: (id) => POINT_SPECS[id],
  });
  return { runner, calls, entries };
}

/** 造一个最小的 ctx（照 cordis 语义收集监听器）。 */
function makeCtx(services = {}) {
  const hooks = new Map();
  return {
    logger: { warn() {}, info() {}, error() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    listener(name) {
      return (hooks.get(name) ?? [])[0];
    },
  };
}

/** 造一个最小的 session：事件数组 + surface 节点 + eventAt。 */
function makeSession({ events = [], nodes = [] } = {}) {
  return {
    events,
    surface: { nodes },
    eventAt(seq) {
      return events[seq];
    },
    header: { cwd: "/tmp" },
  };
}

/** 插件注入的合成消息（与 index.js 的 makeUserMessage 同形）。 */
const syntheticMessage = (kind, text) => ({
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: `decision-engine-${kind}`, form: "notice", summary: text.slice(0, 120) },
});

/** 用户亲手输入的消息（新宿主形状：source.kind='user'）。 */
const userMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: "user" },
});

/** 造一条 user/message 事件（宿主把消息直接放在 data 里）。 */
const userEvent = (seq, text, source = { kind: "user" }) => ({
  type: "user/message",
  seq,
  data: { role: "user", content: [{ type: "text", text }], source },
});

/** 挂载三个点，返回监听器与「steer 到了什么」。 */
function mount({ runner, cfg = baseCfg(), services = {} } = {}) {
  const ctx = makeCtx(services);
  const steered = [];
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => cfg,
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", content: [{ type: "text", text }], source: { kind } }),
  });
  return {
    preStep: ctx.listener("agent/pre-step"),
    turnStopping: ctx.listener("agent/turn-stopping"),
    steered,
  };
}

/** pre-step 的 next：进入这一步。 */
const enter = () => Promise.resolve({ kind: "enter", messages: [] });

// ------------------------------------------------------------ 轮次延续的证据

test("轮次：pendingTools 是真实的未完成工具调用数（不再是硬编码 0）", async () => {
  // 修之前 state.pendingTools 恒为 0：模型永远看到「没有未完成的调用」，
  // 于是「卡在工具执行上」与「正常收束」在证据上一模一样。
  const events = [
    userEvent(0, "先跑一遍测试"),
    { type: "tool/call", seq: 1, data: { callId: "c1", name: "bash", arguments: "{}" } },
    { type: "tool/result", seq: 2, data: { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } } },
    { type: "tool/call", seq: 3, data: { callId: "c2", name: "bash", arguments: "{}" } },
  ];
  let seenState;
  const { runner } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: (call) => {
      seenState = call.state;
      return { answers: stopAnswers, model: "m", latencyMs: 1, cached: false };
    },
  });
  const { turnStopping } = mount({ runner });
  await turnStopping({ turn: 1, agent: { session: makeSession({ events }), steer: () => {} } });
  assert.ok(seenState !== undefined, "应当问过一次");
  assert.equal(seenState.pendingTools, 1, "c1 已回来、c2 没回来，未完成数必须是 1");
});

test("轮次：历史里中断的调用不跨轮累计", async () => {
  // 被中断的轮次会留下永远没有结果的 tool/call。若跨轮累计，pendingTools
  // 会永久 ≥1——那不是报告事实，而是在制造「还有活没干完」的假证据。
  const events = [
    // 上一轮：发出后就被中断，永远没有 tool/result。
    { type: "tool/call", seq: 0, data: { callId: "old", name: "bash", arguments: "{}" } },
    userEvent(1, "新的一轮：修一下这个 bug"),
    { type: "tool/call", seq: 2, data: { callId: "c1", name: "read", arguments: "{}" } },
    { type: "tool/result", seq: 3, data: { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } } },
  ];
  let seenState;
  const { runner } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: (call) => {
      seenState = call.state;
      return { answers: stopAnswers, model: "m", latencyMs: 1, cached: false };
    },
  });
  const { turnStopping } = mount({ runner });
  await turnStopping({ turn: 2, agent: { session: makeSession({ events }), steer: () => {} } });
  assert.equal(seenState.pendingTools, 0, "上一轮遗留的 open call 不属于「现在」");
});

test("轮次：goal 注入会话里第一条真实用户消息（插件注入的不算）", async () => {
  // 修之前 state 里没有用户目标：模型只能从助手最后一句话反推「还有没有
  // 没干完的活」。同时插件自己注入的续轮提示不能被当成目标。
  const events = [
    userEvent(0, "继续把没做完的部分做完", { kind: "decision-engine-turnstop" }),
    userEvent(1, "把 lib 里的 CommonJS 全部改成 ESM，并补测试"),
    { type: "assistant/message", seq: 2, data: { message: { role: "assistant", content: [{ type: "text", text: "开始改" }] } } },
  ];
  let seenState;
  const { runner } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: (call) => {
      seenState = call.state;
      return { answers: stopAnswers, model: "m", latencyMs: 1, cached: false };
    },
  });
  const { turnStopping } = mount({ runner });
  await turnStopping({ turn: 1, agent: { session: makeSession({ events }), steer: () => {} } });
  assert.equal(seenState.goal, "把 lib 里的 CommonJS 全部改成 ESM，并补测试");
  assert.ok(!seenState.goal.includes("[decision-engine-"), "合成消息不得成为目标");
});

test("轮次：awaiting_user 缺席时不 steer（边界未知禁止续轮）", async () => {
  // 旧端点不认识这一问，答案里没有 awaiting_user；此时 unfin 很高也不能续。
  const events = [
    userEvent(0, "帮我选一个方案"),
    { type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "你要选 A 还是 B？" }] } } },
  ];
  const { runner, calls } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: () => ({
      answers: { unfinished: noul(0.9), value: noul(0.9), closed: noul(0.05) },
      model: "m",
      latencyMs: 1,
      cached: false,
    }),
  });
  const { turnStopping, steered } = mount({ runner, cfg: baseCfg({ turnStopMaxSteers: 1 }) });
  await turnStopping({ turn: 1, agent: { session: makeSession({ events }), steer: (m) => steered.push(m) } });
  assert.equal(calls.length, 1, "应当问过一次");
  assert.equal(steered.length, 0, "边界未知时绝不续轮");
});

// ------------------------------------------------------------ 子任务分派的来源校验

test("分派：插件自己注入的合成消息不触发分派", async () => {
  // 修之前 payload.messages 全量拼接：注入的 [decision-engine-delegate] 提示
  // 也是 role=user，于是插件会对着自己的建议再做一次分派判断。
  const { runner, calls } = makeRunner({ modes: { delegate: "enforce" } });
  const { preStep } = mount({ runner });
  const decision = await preStep(
    {
      turn: 1,
      step: 1,
      agent: { session: makeSession() },
      messages: [syntheticMessage("delegate", "[decision-engine-delegate] 建议开 agent team")],
    },
    enter,
  );
  assert.equal(calls.length, 0, "没有用户来源的消息就不该问模型");
  assert.deepEqual(decision, { kind: "enter", messages: [] }, "决策与注入内容都必须原样返回");
});

test("分派：只把用户来源的文本算作 incoming，合成消息被排除", async () => {
  const { runner, calls } = makeRunner({
    modes: { delegate: "enforce" },
    classify: () => ({
      answers: { scope: choice("inline", 0.9), parallel: noul(0.1), blocking: noul(0.1) },
      model: "m",
      latencyMs: 1,
      cached: false,
    }),
  });
  const { preStep } = mount({ runner });
  await preStep(
    {
      turn: 1,
      step: 1,
      agent: { session: makeSession() },
      messages: [
        syntheticMessage("turnStop", "[decision-engine-turnstop] 继续把没做完的部分做完"),
        userMessage("帮我重构这个模块"),
      ],
    },
    enter,
  );
  assert.equal(calls.length, 1, "有真实用户输入时才问");
  assert.equal(calls[0].state.incoming, "帮我重构这个模块");
  assert.equal(calls[0].state.origin, "user", "origin 要说明这段文本的来源");
  assert.ok(!calls[0].state.incoming.includes("[decision-engine-"));
});

test("分派：老宿主没有 source 时按 role 兜底（origin=legacy）", async () => {
  const { runner, calls } = makeRunner({
    modes: { delegate: "enforce" },
    classify: () => ({
      answers: { scope: choice("inline", 0.9), parallel: noul(0.1), blocking: noul(0.1) },
      model: "m",
      latencyMs: 1,
      cached: false,
    }),
  });
  const { preStep } = mount({ runner });
  await preStep(
    {
      turn: 1,
      step: 1,
      agent: { session: makeSession() },
      // 老宿主：消息上没有 source 成员。
      messages: [{ role: "user", content: [{ type: "text", text: "老宿主上的用户消息" }] }],
    },
    enter,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.incoming, "老宿主上的用户消息");
  assert.equal(calls[0].state.origin, "legacy");
});

// ------------------------------------------------------------ 上下文压缩的保守门控

/**
 * 造一次「压到阈值以上、有超长工具结果」的现场。
 * @returns `{ session, services, pruneCalls }`
 */
function compactFixture() {
  const big = "x".repeat(9000);
  const events = [
    {
      type: "tool/result",
      seq: 0,
      data: { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: big }] } },
    },
  ];
  const pruneCalls = { count: 0 };
  const session = makeSession({ events, nodes: [0] });
  const services = {
    tokenMeter: {
      measure: () => ({ totalTokens: 90000, nodes: [{}] }),
    },
    toolResultPruner: {
      pruneSession: () => {
        pruneCalls.count += 1;
        return { pruned: [0], charsRemoved: 9000 };
      },
    },
  };
  return { session, services, pruneCalls };
}

/** compact 点的答案：结论已落地、不需要逐字原文。 */
const distilledAnswers = { distilled: noul(0.95), verbatim_needed: noul(0.05) };

test("压缩：compactAllowPrune=false 时不裁剪，交给宿主摘要", async () => {
  // 修之前：distilled 达线就直接 prune，而 prune 不可逆、证据只有一条概率。
  // 默认必须交回宿主摘要（信息至少还在）。
  const { session, services, pruneCalls } = compactFixture();
  const { runner, calls, entries } = makeRunner({
    modes: { compact: "enforce" },
    cfg: baseCfg({ compactAllowPrune: false }),
    classify: () => ({ answers: distilledAnswers, model: "m", latencyMs: 1, cached: false }),
  });
  const { preStep } = mount({ runner, cfg: baseCfg({ compactAllowPrune: false }), services });
  await preStep({ turn: 1, step: 1, agent: { session }, messages: [] }, enter);
  assert.equal(calls.length, 1, "应当问过一次压缩决策");
  assert.equal(calls[0].state.oversized, 1, "现场必须带上超长结果的数量");
  assert.equal(entries[0]?.action, "summarize", "裁决应是交给摘要");
  assert.equal(pruneCalls.count, 0, "默认配置下一个字节都不许裁");
});

test("压缩：只有 compactAllowPrune=true 时才允许 prune", async () => {
  const { session, services, pruneCalls } = compactFixture();
  const { runner, entries } = makeRunner({
    modes: { compact: "enforce" },
    cfg: baseCfg({ compactAllowPrune: true }),
    classify: () => ({ answers: distilledAnswers, model: "m", latencyMs: 1, cached: false }),
  });
  const { preStep } = mount({ runner, cfg: baseCfg({ compactAllowPrune: true }), services });
  await preStep({ turn: 1, step: 1, agent: { session }, messages: [] }, enter);
  assert.equal(entries[0]?.action, "prune");
  assert.equal(pruneCalls.count, 1, "显式打开后才真的裁剪");
});
