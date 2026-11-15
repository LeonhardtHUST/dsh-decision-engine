/**
 * 子任务分派、轮次延续、上下文压缩 —— 三个都挂在 `agent/pre-step` 与
 * `agent/turn-stopping` 上的适配器。
 *
 * 为什么合在一个文件：三者的触发条件都依赖「这一步/这一轮到哪了」，
 * 分成三个监听器会让同一份 inbox/step 状态被读三遍，也让「这一步到底问了
 * 几个决策点」变得难以推断。这里用一个 pre-step 监听器内部分派。
 *
 * 各点的生效方式都刻意保守：
 *
 *   分派    只注入一条 runtime-context 建议，绝不替模型开子代理
 *           （开子代理是模型的决定，插件越权会让上下文分叉不可控）
 *   轮次    用 `agent.steer()` 续一轮，且每轮最多一次
 *   压缩    只在自己判定够便宜时先跑确定性裁剪；摘要交给 compaction-basic
 *
 * @module dsh-decision-engine/adapters/agent
 */

import { sessionEventsOf } from "../session-events.js";

/**
 * 挂载分派 / 轮次 / 压缩三个监听器。
 * @param ctx - cordis 插件上下文。
 * @param deps - 运行期依赖。
 */
export function mountAgentPoints(ctx, deps) {
  const { runner, getConfig, digestRecent, telemetry, makeUserMessage } = deps;

  /** 每会话的续轮计数：turn → 已 steer 次数。防止自续无限循环。 */
  const steerCounts = new WeakMap();

  const steersThisTurn = (session, turn) => {
    const map = steerCounts.get(session);
    return map?.get(turn) ?? 0;
  };

  const noteSteer = (session, turn) => {
    let map = steerCounts.get(session);
    if (map === undefined) {
      map = new Map();
      steerCounts.set(session, map);
    }
    map.set(turn, (map.get(turn) ?? 0) + 1);
    // 只保留最近两轮，避免长会话里这个 Map 无界增长。
    if (map.size > 2) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  };

  /** 取最近一步的助手文本，作为「这一轮说了什么」的判断依据。 */
  const lastAssistantText = (session, chars) => {
    const events = sessionEventsOf(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "assistant/message") continue;
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
        .filter((part) => part.length > 0)
        .join(" ");
      if (text.length > 0) return text.slice(-chars);
    }
    return "";
  };

  // ---------------------------------------------------------------- pre-step
  const preStep = async (payload, next) => {
    const decision = await next();
    // 判 reject 说明这一步根本没进入，注入建议没有意义。
    if (decision.kind === "reject") return decision;
    const agent = payload?.agent;
    if (agent?.session === undefined) return decision;
    const cfg = getConfig();

    try {
      const additions = [];

      // ---- 上下文压缩 ------------------------------------------------
      if (runner.participates("compact")) {
        const compacted = await maybePruneContext(ctx, agent, payload, cfg, runner, telemetry);
        if (compacted !== undefined) additions.push(compacted);
      }

      // ---- 子任务分派 ------------------------------------------------
      // 只在「每轮第一步 + 这一步确实带着新的用户输入」时判断：
      // 分派决策只在这个时刻可能改变，后续步骤再问必然是 inline。
      //
      // 只认**用户来源**的消息。修之前这里把 `payload.messages` 全部拼接：
      // 插件自己注入的 `[decision-engine-*]` 提示也是 `role: 'user'`，于是
      // 「插件建议开 subagent」会被当成一条新的用户任务，让分派判断对着
      // 自己的建议再判一次——模型很容易把建议读成用户要求，滚成自我确认。
      if (runner.participates("delegate") && payload.step === 1 && Array.isArray(payload.messages)) {
        const userInput = collectUserInput(payload.messages);
        if (userInput !== undefined) {
          const result = await runner.ask(
            "delegate",
            {
              turn: payload.turn,
              step: payload.step,
              origin: userInput.origin,
              incoming: userInput.incoming,
              recent: digestRecent(agent.session, cfg.recentMessages, cfg.recentMessageChars),
            },
            // session / turn / step 只给「决策历史」明细用，不参与裁决。
            { signal: payload.signal, session: agent.session, turn: payload.turn, step: payload.step },
          );
          // 只有明确建议「开子代理/组队」时才注入提示；inline 不打扰。
          if (runner.enforces("delegate") && result.action?.kind === "advise") {
            additions.push(
              makeUserMessage(
                `[decision-engine-delegate] ${result.action.reason}\n` +
                  `如果确实适合，请用 subagent / 团队工具把它分出去；否则直接在当前上下文里做完，不要为了分派而分派。`,
                "delegate",
              ),
            );
          }
        }
      }

      if (additions.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, ...additions] };
    } catch (error) {
      telemetry.noteAdapterError("pre-step", error, ctx);
      return decision;
    }
  };

  ctx.on("agent/pre-step", preStep);

  // ----------------------------------------------------------- turn-stopping
  /**
   * 轮次延续：`agent/turn-stopping` 是 serial 而不是 waterfall，返回值不传递，
   * 唯一的生效方式是调用 `agent.steer(...)` 把消息塞回 inbox —— 机器随后
   * 重新读一遍 inbox，有东西就再跑一步。
   *
   * 契约明确写了「数据决定，监听器顺序不改变结果」，因此这里唯一能做的就是
   * 「steer 或不 steer」，不能否决别的监听器的意见。
   */
  const turnStopping = async (payload) => {
    const agent = payload?.agent;
    if (agent?.session === undefined) return;
    if (!runner.participates("turnStop")) return;

    try {
      const cfg = getConfig();
      // 每轮最多续一次：否则一轮里的空转会被无限放大成烧钱循环。
      if (steersThisTurn(agent.session, payload.turn) >= Math.max(0, cfg.turnStopMaxSteers ?? 1)) return;

      const last = lastAssistantText(agent.session, cfg.recentMessageChars * 4);
      const result = await runner.ask(
        "turnStop",
        {
          turn: payload.turn,
          // 用户最初要什么。修之前 state 里没有它，模型只能从最后一句助手
          // 文本反推「还有没有活没干完」——没有对照物，判断退化成猜测。
          goal: firstUserText(agent.session, cfg.recentMessageChars * 4),
          last,
          // 真实未完成计数。修之前这里是硬编码的 0：模型永远看到「没有
          // 未完成的工具调用」，卡在工具执行上的轮次与正常收束的轮次在
          // 证据上一模一样（详见 countPendingToolCalls）。
          pendingTools: countPendingToolCalls(agent.session),
          steered: steersThisTurn(agent.session, payload.turn),
        },
        // session / turn 只给「决策历史」明细用，不参与裁决。
        { signal: payload.signal, session: agent.session, turn: payload.turn },
      );

      if (!runner.enforces("turnStop")) return;
      // 只有 `continue` 才续轮。`defer`（这一轮在等用户，DEC-045）与 `stop`
      // 都**不续轮**——插件在这两种情况下把决定权交还用户 / 主模型。
      //
      // 这里刻意**不**为 `defer` 做任何补偿动作（比如「提醒模型一句用户在等」）：
      // 插件一旦在模型等用户时插话，就是替用户抢答——那正是本条边界要防的事。
      if (result.action?.kind !== "continue") return;
      if (typeof agent.steer !== "function") return;

      noteSteer(agent.session, payload.turn);
      agent.steer(
        makeUserMessage(
          `[decision-engine-turnstop] ${result.action.reason}\n继续把没做完的部分做完；如果其实已经完成，直接说明结论即可。`,
          "turnStop",
        ),
      );
      ctx.logger?.info?.(`dsh-decision-engine: 第 ${payload.turn} 轮按决策续一轮`);
    } catch (error) {
      telemetry.noteAdapterError("turnStop", error, ctx);
    }
  };

  ctx.on("agent/turn-stopping", turnStopping);
}

/** 把一条消息压成纯文本（只取 text block）。 */
function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * 插件自己注入的合成消息统一带这个文本前缀。
 *
 * 只用于**老宿主**兜底（那时消息没有 `source`）：新宿主上 `source.kind`
 * 已经能确定性区分，不需要猜文本。
 */
const SYNTHETIC_PREFIX = "[decision-engine-";

/**
 * 判断一条消息是不是用户亲手输入的。
 *
 * 为什么需要它：`role: 'user'` 不代表「用户说的」——插件通过 `agent.steer()`
 * 注入的提示、宿主注入的运行时上下文都是 role=user。把它们当成新任务，
 * 会让分派判断对着自己的建议做决策（见 pre-step 里的注释）。
 *
 * 判定顺序（从严到宽）：
 *   1. 有 `source` → 只认 `source.kind === 'user'`（宿主自己声明的来源）；
 *   2. 没有 `source`（老宿主）→ `role === 'user'` 且文本不带插件前缀。
 *
 * @param message - 一条消息（Message 或 Message-like 对象）。
 * @returns `'user'` / `'legacy'`（老宿主兜底）/ undefined（不是用户输入）。
 */
function userOriginOf(message) {
  const source = message?.source;
  if (source !== undefined && source !== null && typeof source === "object") {
    return source.kind === "user" ? "user" : undefined;
  }
  if (message?.role !== "user") return undefined;
  return textOf(message).startsWith(SYNTHETIC_PREFIX) ? undefined : "legacy";
}

/**
 * 从本次 pre-step 的 messages 里收出真正来自用户的文本。
 *
 * 修之前：把所有消息（包括插件注入的 `[decision-engine-*]` 提示）拼成一段
 * 当作「新的用户任务」，于是每一轮都可能对着自己的提示重新分派。
 *
 * @param messages - pre-step 载荷里的消息数组。
 * @returns `{ incoming, origin }`；没有可归因的用户文本时返回 undefined
 *   （→ 整个分派点不判断，而不是拿空串去问模型）。
 */
function collectUserInput(messages) {
  const parts = [];
  let sawUser = false;
  let sawLegacy = false;
  for (const message of messages) {
    const origin = userOriginOf(message);
    if (origin === undefined) continue;
    if (origin === "user") sawUser = true;
    else sawLegacy = true;
    const text = textOf(message);
    if (text.length > 0) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  return {
    incoming: parts.join("\n").slice(0, 1200),
    origin: sawUser ? (sawLegacy ? "user+legacy" : "user") : "legacy",
  };
}

/**
 * 取会话里**第一条真实用户消息**，作为这一轮的原始目标（截断）。
 *
 * 只认 `source.kind === 'user'`（老宿主按 role 兜底并排除插件前缀）：
 * 插件注入的 `[decision-engine-*]` 提示如果参与了 goal，目标就会从
 * 「用户要什么」漂移到「继续把没做完的部分做完」，续轮判断失去基准。
 *
 * @param session - 宿主 Session。
 * @param chars - 截断长度（超出部分用省略号标记）。
 * @returns 目标文本；找不到返回空串。
 */
function firstUserText(session, chars) {
  for (const event of sessionEventsOf(session)) {
    if (event?.type !== "user/message") continue;
    // 新宿主把消息放在 data.message 里，老宿主/兼容层可能直接放 data。
    const message = event.data?.message ?? event.data;
    if (userOriginOf(message) === undefined) continue;
    const text = textOf(message);
    if (text.length === 0) continue;
    return text.length > chars ? `${text.slice(0, chars)}…` : text;
  }
  return "";
}

/**
 * 数「已经发出 tool/call 但还没有对应 tool/result」的数量。
 *
 * 修之前 `state.pendingTools` 是硬编码的 0：模型永远看到「没有未完成的
 * 工具调用」，于是「卡在工具执行上的一轮」与「正常收束的一轮」在证据上
 * 完全一样。
 *
 * 宿主的事件是可直接配对的**数据**（不是猜意图）：
 *   tool/call   的 `data.callId`
 *   tool/result 的 `data.message.toolCallId`
 * 配不上对的就是还没回来。老格式两侧都可能缺 id，此时按先进先出配一对。
 *
 * 只统计**最近一条用户消息之后**的调用：被中断的轮次会留下永远没有结果的
 * 历史调用，若跨轮累计，`pendingTools` 会永久 ≥1——那不是在报告事实，而是
 * 在给模型制造「还有活没干完」的假证据。
 *
 * @param session - 宿主 Session。
 * @returns 最近一段里未完成的工具调用数。
 */
function countPendingToolCalls(session) {
  /** callId → 仍在等待结果的调用。 */
  const open = new Map();
  /** 两侧都没有 id 的老格式调用：只能按数量配。 */
  let anonymous = 0;
  const reset = () => {
    open.clear();
    anonymous = 0;
  };
  for (const event of sessionEventsOf(session)) {
    // 新的用户输入 = 新的一段工作：之前没回来的调用不再属于「现在」。
    if (event?.type === "user/message") {
      reset();
      continue;
    }
    if (event?.type === "tool/call") {
      const callId = callIdOf(event);
      if (callId === undefined) anonymous += 1;
      else open.set(callId, true);
      continue;
    }
    if (event?.type !== "tool/result") continue;
    const callId = callIdOf(event);
    if (callId !== undefined && open.has(callId)) {
      open.delete(callId);
    } else if (anonymous > 0) {
      anonymous -= 1;
    } else if (callId === undefined) {
      // 两侧都缺 id：按先进先出配最早那个未完成调用。
      const oldest = open.keys().next();
      if (!oldest.done) open.delete(oldest.value);
    }
    // 有 id 但找不到对应 call（例如日志被截断）：忽略，不虚构一个待办。
  }
  return open.size + anonymous;
}

/**
 * 从 tool 事件里取调用 id（兼容两种宿主形状）。
 * @param event - tool/call 或 tool/result 事件。
 * @returns 调用 id，或 undefined（老格式没有 id）。
 */
function callIdOf(event) {
  const id = event?.data?.callId ?? event?.data?.message?.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * 上下文压缩：判断「现在只丢陈旧工具结果够不够」。
 *
 * 生效方式是调用宿主的 `toolResultPruner.pruneSession(session)` —— 这是一个
 * 纯确定性、无模型、replay 安全的裁剪，把超长工具结果的中间段换成标记。
 * 裁完之后 compaction-basic 会在同一步重新测量压力：低于阈值它就**跳过摘要**，
 * 于是真正省下一次摘要调用。
 *
 * 绝不在 observe 模式下裁剪（那会改变会话内容），也绝不在没超阈值时裁剪。
 *
 * @returns 需要追加进这一步的提示消息，或 undefined（不注入）。
 */
async function maybePruneContext(ctx, agent, payload, cfg, runner, telemetry) {
  const meter = ctx.get?.("tokenMeter");
  const pruner = ctx.get?.("toolResultPruner");
  if (meter === undefined || pruner === undefined) return undefined;

  let measurement;
  try {
    measurement = meter.measure(agent.session);
  } catch {
    return undefined;
  }
  const total = Number(measurement?.totalTokens ?? 0);
  if (total <= 0) return undefined;

  // 触发线：compaction-basic 默认 thresholdRatio 0.8。它只在达到 0.8×contextWindow
  // 时才动手，所以我们要在它之前判断，取 0.7 作为「提前介入」的位置。
  // 拿不到 contextWindow 时退回绝对阈值，避免完全不动。
  const contextWindow = Number(cfg.compactContextWindow ?? 0);
  const threshold = contextWindow > 0 ? contextWindow * (cfg.compactThresholdRatio ?? 0.7) : (cfg.compactTriggerTokens ?? 100000);
  if (total < threshold) return undefined;

  // 先数一下有多少超长工具结果，没有就不必问模型。
  const oversized = countOversizedToolResults(agent.session, cfg.compactToolResultChars ?? 8192);
  if (oversized === 0) return undefined;

  const result = await runner.ask(
    "compact",
    {
      totalTokens: total,
      triggerTokens: Math.round(threshold),
      oversized,
      nodes: Array.isArray(measurement?.nodes) ? measurement.nodes.length : 0,
      recent: digestRecentSafe(agent.session, cfg),
    },
    // session 只给「决策历史」明细用，不参与裁决。
    { signal: payload.signal, session: agent.session },
  );
  // 校验在**任何副作用之前**：裁决允许（prune）才动手。这一句此前被
  // 误删过，结果是「observe 模式也会真的裁剪上下文」——观察模式绝不能
  // 改变行为，这与 `turnStop` 的 `if (!runner.enforces(...)) return;` 同一条规矩。
  if (!runner.enforces("compact")) return undefined;
  if (result.action?.kind !== "prune") return undefined;

  let pruned;
  try {
    pruned = pruner.pruneSession(agent.session);
  } catch (error) {
    telemetry.noteAdapterError("compact", error, ctx);
    return undefined;
  }
  if (pruned === undefined || pruned.pruned.length === 0) return undefined;

  ctx.logger?.info?.(
    `dsh-decision-engine: 裁剪 ${pruned.pruned.length} 条超长工具结果，省 ${pruned.charsRemoved} 字符（${result.action.reason}）`,
  );
  return undefined;
}

/** 数当前 surface 上超长的 tool/result 数量。 */
function countOversizedToolResults(session, limit) {
  let count = 0;
  let nodes;
  try {
    nodes = session.surface?.nodes;
  } catch {
    return 0;
  }
  if (nodes === undefined) return 0;
  for (const seq of nodes) {
    let event;
    try {
      event = session.eventAt(seq);
    } catch {
      continue;
    }
    if (event?.type !== "tool/result") continue;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    let chars = 0;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
    }
    if (chars > limit) count += 1;
  }
  return count;
}

/** 压缩判断里只需要很短的上下文；单独一个 helper 避免把大字符串传进 state。 */
function digestRecentSafe(session, cfg) {
  try {
    const count = Math.min(cfg.recentMessages ?? 0, 4);
    if (count <= 0) return "";
    const events = sessionEventsOf(session);
    const lines = [];
    for (let index = events.length - 1; index >= 0 && lines.length < count; index -= 1) {
      const event = events[index];
      if (event?.type !== "user/message" && event?.type !== "assistant/message") continue;
      const text = textOf(event.data?.message ?? event.data);
      if (text.length > 0) lines.unshift(text.slice(0, 160));
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
