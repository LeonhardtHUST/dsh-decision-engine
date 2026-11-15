import { buildTrustedContext, guardService } from "./context.js";
import { classifyToolEffect } from "./effects.js";
import { evaluateMandatoryPolicy, mandatoryApprovalDecision } from "./policy.js";
import { GUARD_QUESTIONS_VERSION, guardQuestions, parseModelAdvisory, decideModelAdvisory } from "./advisory.js";
import { createGuardAudit, hashSummary, joinHostOutcome } from "./audit.js";
import { classifyWorkspaceTarget } from "../scope.js";
import { resolveTolerance, severityOf, toleranceCutoff } from "../tolerance.js";
import { redactGuardData, reviewWithFallback, GUARD_FALLBACKS } from "./fallback.js";
import { guardOutcomeMessage, toleranceAskAction } from "./messages.js";

export function approvalOutcomeForCall(session, callId, toolName, afterSeq) {
  if (!Number.isFinite(afterSeq) || !callId || typeof session?.snapshotEvents !== "function") return "unknown";
  try {
    const events = session.snapshotEvents();
    const asked = events.filter((event) => event.type === "approval/asked" && event.seq > afterSeq && event.data?.callId === callId && event.data?.toolName === toolName).at(-1);
    if (!asked) return "unknown";
    const decided = events.find((event) => event.type === "approval/decided" && event.seq > asked.seq && event.data?.id === asked.data.id);
    return ["allowed-once", "rejected", "cancelled", "unavailable"].includes(decided?.data?.outcome) ? decided.data.outcome : "unknown";
  } catch { return "unknown"; }
}

const numberOrNull = (value) => Number.isFinite(value) ? value : null;
const identityOrNull = (value) => typeof value === "string" && value ? redactGuardData(value).replace(/[\r\n\0]/g, " ").slice(0, 256) : null;
const idleEvaluation = () => ({ status: "not_requested", provider: null, model: null, latencyMs: null, reason: null });
/**
 * 是否走「自动审查」：把软性询问交给回退审查者，而不是直接拒绝。
 *
 * 这里刻意**不**把 `approvalPolicy === "never"` 算进来：这个开关同时
 * 决定「模型失效 / 答案畸形 / 审查异常」是否走回退，而那条链路必须保持
 * fail-closed（失败不能变成一次放行）。never 下「模型给出有效意见但结论
 * 是 ask」的情况在下面的分支单独处理：safe 交宿主沙箱，其余交回退裁决。
 */
const automaticReview = (context, config) =>
  context?.permissionPreset === "auto"
  || config?.tolerance === "autonomous";

export function mountGuard(ctx, deps) {
  const { getConfig, reloadOwnConfig, effectivePointModes, client, toleranceCalibrator, digestRecent, previewArguments, logDecision, recordGuardDetail } = deps;
  const pending = new Map();
  const mandatoryByToken = new Map();
  /**
   * 短窗判定记忆（审计 P0-2）。
   *
   * 无审批通道时，同一 `(session, tool, argsHash)` 的裁决对措辞/上下文很
   * 敏感，重试常出现「先拒后放」。这里把同一调用在 120 秒内的首次结论
   * 复用到后续重试：同参数同会话得到同一个答案，代理不会因为换措辞而
   * 意外通过，也不会白烧一次模型调用。
   *
   * 只在 `approvalAvailable === false` 时启用：一旦有真人/审批通道，
   * 第二次调用可能带着新的批准，不能被旧结论覆盖。
   */
  const verdictMemo = new Map();
  const VERDICT_MEMO_MS = 120000;
  let auditWriteFailures = 0;
  const toolService = ctx.get?.("tools");
  if (typeof toolService?.guard === "function") {
    const dispose = toolService.guard((exec) => {
      const config = getConfig();
      if (!config.enabled || config.guardEnabled === false || config.guardPolicyMode === "observe" || effectivePointModes(config).authorize !== "enforce") return;
      const recorded = mandatoryByToken.get(exec.token);
      if (recorded && (recorded.argsHash !== hashSummary(exec.arguments).sha256 || recorded.toolName !== exec.name || recorded.callId !== exec.callId || recorded.sessionId !== exec.agent?.session?.id)) {
        return { reason: "审查后的工具参数或调用身份发生变化，已阻止执行", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_REVIEW_CHANGED" } };
      }
      if (recorded?.finalAction === "deny" || recorded?.finalAction === "cancel" || recorded?.status === "deny" || (recorded?.status === "requires_approval" && approvalOutcomeForCall(exec.agent?.session, exec.callId, exec.name, recorded.approvalAfterSeq) !== "allowed-once")) {
        return { reason: "此调用需要本次用户批准，模型或回退策略不能覆盖该权限约束", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_MANDATORY_DENY" } };
      }
      if (!recorded && classifyToolEffect({ toolName: exec.name, args: exec.arguments }).highImpact !== false) {
        return { reason: "此调用尚未经过完整审查，已阻止执行", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_MISSING_REVIEW" } };
      }
    });
    ctx.effect?.(() => dispose);
  }
  const keyOf = (exec) => `${exec.agent?.session?.id ?? "unknown"}:${exec.callId ?? "unknown"}`;
  const emit = async (audit) => {
    try {
      const persisted = await logDecision({ ts: new Date().toISOString(), point: "authorize", tag: "guard", action: audit.pluginReturnedAction, provider: audit.judge?.provider ?? "", model: audit.judge?.model ?? "", audit, auditWriteFailures });
      if (persisted === false) { auditWriteFailures += 1; ctx.logger?.warn?.("decision-engine: guard audit persistence failed"); }
    } catch { auditWriteFailures += 1; ctx.logger?.warn?.("decision-engine: guard audit persistence failed"); }
  };
  ctx.on("tools/result", (exec, result) => {
    const key = keyOf(exec);
    const audit = pending.get(key);
    if (!audit) return;
    pending.delete(key);
    const reviewed = mandatoryByToken.get(exec.token);
    mandatoryByToken.delete(exec.token);
    void emit(joinHostOutcome(audit, { callId: exec.callId, sessionId: exec.agent?.session?.id, result, approvalOutcome: approvalOutcomeForCall(exec.agent?.session, exec.callId, exec.name, reviewed?.approvalAfterSeq) }));
  });

  const listener = async (exec, next) => {
    const session = exec.agent?.session;
    let context;
    let effect;
    let mandatory;
    let result;
    let advisory;
    let baseAction;
    let tolerated;
    let fallback;
    let state = { tool: exec.name, argsSummary: hashSummary(exec.arguments) };
    let questions;
    let pointMode = "off";
    let config;
    let primary = idleEvaluation();
    let secondary = idleEvaluation();
    let decisionSource = "local_policy";

    const runFallback = async () => {
      const started = Date.now();
      let llm;
      const serviceSources = {};
      llm = guardService(ctx, exec.agent, "llm", serviceSources);
      fallback = await reviewWithFallback({ config, context, mandatory: config.guardPolicyMode === "observe" ? undefined : mandatory, state, advisory, session, llm, signal: exec.signal });
      decisionSource = ["allow", "deny"].includes(fallback.fallback) ? "fallback_policy" : "fallback_model";
      secondary = {
        status: fallback.selection ? (fallback.reason === "fallback-review-failed" || fallback.kind === "cancel" ? "failed" : "completed") : "not_requested",
        provider: identityOrNull(fallback.selection?.provider), model: identityOrNull(fallback.selection?.model),
        latencyMs: fallback.selection ? Date.now() - started : null, reason: fallback.reason, serviceScope: serviceSources.llm ?? "unavailable",
      };
      return fallback;
    };

    const finish = async (rawAction, degradedReason) => {
      const action = guardOutcomeMessage(rawAction, mandatory);
      const observing = pointMode !== "enforce";
      const pluginReturnedAction = observing || action.kind === "delegate" ? "defer_to_host" : action.kind;
      const reviewed = mandatoryByToken.get(exec.token);
      if (reviewed && !observing) mandatoryByToken.set(exec.token, { ...reviewed, finalAction: action.kind });
      const requested = [primary, secondary].filter((evaluation) => evaluation.status !== "not_requested");
      const modelEvaluation = { status: requested.length ? (requested.at(-1).status === "failed" ? "failed" : "completed") : "not_requested", primary, fallback: secondary };
      const judge = secondary.provider || secondary.model ? secondary : primary;
      const latencyMs = requested.length ? requested.reduce((total, evaluation) => total + (evaluation.latencyMs ?? 0), 0) : null;
      const audit = createGuardAudit({
        callId: exec.callId, sessionId: session?.id, toolName: exec.name, args: exec.arguments, questions: questions ?? {},
        time: new Date().toISOString(), context, effect, mandatory, advisory, modelEvaluation, decisionSource,
        cacheStatus: primary.status === "cache_hit" ? "hit" : primary.status === "not_requested" ? "not_requested" : "miss",
        baseAction: baseAction?.kind ?? action.kind, tolerance: tolerated, pluginReturnedAction,
        degradedReason: degradedReason ?? null, model: judge.model,
        questionsVersion: questions ? GUARD_QUESTIONS_VERSION : "not_requested",
      });
      const trace = { ...audit, judge, modelEvaluation, decisionSource, reasonCode: action.reasonCode, humanReason: action.humanReason ?? action.reason, reused: action.reused === true, callId: exec.callId ?? "unknown", sessionId: session?.id ?? "unknown", pluginReturnedAction, baseAction: baseAction?.kind ?? action.kind, tolerance: { ...audit.tolerance, level: config?.tolerance ?? "default" }, fallback: fallback ?? null, degradedReason: degradedReason ?? null };
      pending.set(keyOf(exec), trace);
      if (pending.size > 2048) pending.delete(pending.keys().next().value);
      await emit(trace);
      if (result?.statsFacts !== undefined) {
        try { client.recordDecision({ facts: result.statsFacts, action: action.kind, detail: action.humanReason ?? action.reason, degraded: Boolean(degradedReason) }); }
        catch { ctx.logger?.warn?.("decision-engine: guard statistics unavailable"); }
      }
      const reviewMode = { automatic: automaticReview(context, config), permissionPreset: context?.permissionPreset ?? "unknown", approvalPolicy: context?.approvalPolicy ?? "unknown", approvalAvailable: context?.approvalAvailable ?? "unknown", sandboxMode: context?.sandboxMode ?? "unknown", serviceSources: context?.serviceSources ?? {} };
      const scores = {
        reviewMode,
        risk_p: advisory?.risk?.confidence ?? null, raw_decision_confidence: advisory?.risk?.confidence ?? null,
        confidenceKind: advisory?.risk?.confidenceKind ?? "unavailable", p_high: advisory?.risk?.probabilities?.high ?? null,
        p_non_low: advisory?.risk?.probabilities ? advisory.risk.probabilities.high + advisory.risk.probabilities.medium : null,
        risk_severity: tolerated?.severity ?? null, calibrated_p_unsafe: null, mandatory: mandatory?.status ?? "unknown",
        tolerance: tolerated ?? null, decisionSource, reasonCode: action.reasonCode, reused: action.reused === true, modelEvaluation,
      };
      const detailResult = requested.length ? {
        provider: judge.provider ?? "", model: judge.model ?? "", latencyMs,
        cached: judge === primary && primary.status === "cache_hit",
        inputTokens: judge === primary ? result?.inputTokens : undefined,
        outputTokens: judge === primary ? result?.outputTokens : undefined,
        answers: { summary: hashSummary(result?.answers ?? null), model_result: audit.model_result, modelEvaluation },
      } : undefined;
      try {
        recordGuardDetail({ session, pointMode, exec,
          state: { summary: hashSummary(state), contextVersion: context?.contextVersion ?? "unavailable", effect: effect?.kind ?? "unclassified", mandatory: mandatory?.status ?? "unknown", modelEvaluation, decisionSource },
          questions: { status: questions ? primary.status : "not_requested", summary: hashSummary(questions ?? {}), version: questions ? GUARD_QUESTIONS_VERSION : "not_requested" },
          result: detailResult, action: action.kind, detail: action.humanReason ?? action.reason, degraded: Boolean(degradedReason), scores,
        });
      } catch { ctx.logger?.warn?.("decision-engine: guard detail persistence failed"); }
      if (observing || action.kind === "delegate") return next();
      if (action.kind === "cancel") return { kind: "cancel" };
      if (action.kind === "deny") {
        const code = action.reasonCode === "approval-policy-never" ? "DECISION_ENGINE_APPROVAL_DISABLED"
          : action.reasonCode === "approval-channel-unavailable" ? "DECISION_ENGINE_APPROVAL_UNAVAILABLE" : "DECISION_ENGINE_GUARD_DENY";
        return { kind: "deny", reason: action.reason, info: { name: "DecisionEngineGuardError", code, reason: action.reasonCode } };
      }
      return { kind: "ask", reason: action.reason, ...(action.displayReason ? { displayReason: action.displayReason } : {}) };
    };

    try {
      await reloadOwnConfig();
      config = getConfig();
      if (!config.enabled || config.guardEnabled === false) return next();
      pointMode = effectivePointModes(config).authorize ?? "off";
      if (pointMode === "off") return next();
      if (exec.signal?.aborted) return finish({ kind: "cancel", reason: "review-cancelled" });
      context = await buildTrustedContext({ agent: exec.agent, ctx, exec, host: { downstreamPolicyEnforced: pointMode === "enforce" && config.guardPolicyMode !== "observe" && typeof toolService?.guard === "function" } });
      const scope = classifyWorkspaceTarget({ tool: exec.name, args: exec.arguments, roots: context.workspaceRoots, cwd: context.cwd ?? session?.header?.cwd });
      effect = classifyToolEffect({ toolName: exec.name, args: exec.arguments, trustedContext: context, scope });
      mandatory = evaluateMandatoryPolicy({ context, effect });
      state = { ...state, contextVersion: context.contextVersion, cwd: session?.header?.cwd ?? null, cwdSource: "session-header", workspaceRoots: context.workspaceRoots, effect: { kind: effect.kind, scope: scope.kind }, permissionContext: { mandatory: mandatory.status, approvalPolicy: context.approvalPolicy, sandboxMode: context.sandboxMode }, reasonCodes: mandatory.reasonCodes };
      if (exec.token !== undefined) {
        let approvalAfterSeq;
        try { approvalAfterSeq = session.snapshotEvents().reduce((last, event) => Number.isFinite(event.seq) ? Math.max(last, event.seq) : last, -1); } catch { approvalAfterSeq = undefined; }
        mandatoryByToken.set(exec.token, { ...mandatory, approvalAfterSeq, argsHash: hashSummary(exec.arguments).sha256, toolName: exec.name, callId: exec.callId, sessionId: session?.id });
        if (mandatoryByToken.size > 2048) mandatoryByToken.delete(mandatoryByToken.keys().next().value);
      }
      const enforcingPolicy = config.guardPolicyMode !== "observe";
      if (enforcingPolicy && mandatory.status === "deny") return finish({ kind: "deny", reason: mandatory.reasonCodes[0] });
      if (enforcingPolicy && mandatory.status === "requires_approval") return finish(mandatoryApprovalDecision(mandatory, context));
      if (mandatory.status === "safe" && ["read_local", "internal_message", "internal_state"].includes(effect.kind)) return finish({ kind: "delegate", reason: "verified-local-operation-defer-to-host" });

      // 短窗判定记忆（见 verdictMemo 的说明）：同会话、同工具、同参数在
      // 120 秒内复用首次结论。放在本地快路径之后、模型调用之前——既省掉
      // 重复模型请求，也让「先拒后放」不再发生。
      const memoKey = `${session?.id ?? "unknown"}\u0000${exec.name}\u0000${hashSummary(exec.arguments).sha256}`;
      const memoized = context.approvalAvailable === false ? verdictMemo.get(memoKey) : undefined;
      if (memoized !== undefined && Date.now() - memoized.at <= VERDICT_MEMO_MS) {
        return finish({ kind: memoized.kind, reason: memoized.reason, reasonCode: memoized.reasonCode, humanReason: memoized.humanReason, reused: true }, memoized.degradedReason);
      }

      state = redactGuardData({ ...state, args_preview: previewArguments(redactGuardData(exec.arguments), config.argsHeadChars, config.argsTailChars), recent: digestRecent(session, config.recentMessages, config.recentMessageChars), recentAuthority: "untrusted-context-only", trustedContext: { originalUserGoal: context.originalUserGoal ?? "unknown", goalSource: context.goalSource } });
      const sliceBudget = Math.floor(Math.max(500, Number(config.maxStateChars) || 6000) / 5);
      state.recent = String(state.recent ?? "").slice(0, sliceBudget);
      state.args_preview = String(state.args_preview ?? "").slice(0, sliceBudget);
      state.trustedContext.originalUserGoal = String(state.trustedContext.originalUserGoal).slice(0, sliceBudget);
      questions = guardQuestions();
      const primaryStarted = Date.now();
      try {
        result = await client.classify({ point: "authorize", tag: "guard", mode: config.mode, pointMode, tool: exec.name, state, questions, signal: exec.signal });
        advisory = result && !result.degraded ? parseModelAdvisory(result.answers) : undefined;
        primary = { status: advisory?.status === "valid" ? (result.cached ? "cache_hit" : "completed") : "failed", provider: identityOrNull(result?.provider), model: identityOrNull(result?.model), latencyMs: numberOrNull(result?.latencyMs) ?? Date.now() - primaryStarted, reason: result?.degraded ?? (advisory?.status === "valid" ? null : "answer-shape-mismatch"), validationErrors: advisory?.errors ?? [], metadataWarnings: advisory?.metadata?.warnings ?? [], probabilityStatus: advisory?.metadata?.probabilityStatus ?? "unavailable" };
      } catch {
        primary = { ...idleEvaluation(), status: "failed", latencyMs: Date.now() - primaryStarted, reason: "primary-review-exception" };
      }
      if (exec.signal?.aborted) return finish({ kind: "cancel", reason: "review-cancelled" });
      const degradedReason = primary.status === "failed" ? primary.reason : undefined;
      baseAction = advisory?.status === "valid" ? decideModelAdvisory(advisory, config) : { kind: "ask", reason: "advisory-unavailable" };
      const severity = advisory?.status === "valid" ? severityOf(advisory, { injectionFloorThreshold: config.guardInjectionAskThreshold }) : 1;
      if (advisory?.status === "valid") toleranceCalibrator.observe(result.provider ?? "", result.model, severity);
      const cutoffInfo = toleranceCutoff({ level: config.tolerance, calibrator: toleranceCalibrator, provider: result?.provider ?? "", model: result?.model });
      tolerated = resolveTolerance({ level: config.tolerance, legacyKind: baseAction.kind, severity, cutoff: cutoffInfo.cutoff, mandatory: enforcingPolicy ? mandatory : undefined, approvalAvailable: context.approvalAvailable });
      // 档位改变默认判断时，`reason` 必须是**稳定枚举**：此前直接把档位 note
      // （`tolerance=relaxed（严重度 0.680 ≥ 0.600…）`）当 reason，导致
      // reasonCode 出现 61 种中文长句，机器聚合被拆碎、英文界面显示中文。
      // note 保留进 humanReason，供人读与审计核对。
      let action = tolerated.kind === baseAction.kind
        ? baseAction
        : tolerated.kind === "ask"
          ? { kind: "ask", reason: "tolerance-ask", reasonCode: "tolerance-ask", humanReason: tolerated.note }
          : { kind: "delegate", reason: "tolerance-delegate", reasonCode: "tolerance-delegate", humanReason: tolerated.note };
      decisionSource = "primary_model";
      // 为什么「本地未知副作用」可以只凭主模型意见收尾（去掉冗余的第二次复核）：
      //
      // `mandatory=unknown` 只表示「本地静态规则无法判定这次调用的权限边界」，
      // 它本身**不是**「需要升级」。当 effect 只是 unknown（没有任何强制权限
      // 约束）、主模型给出了有效意见且结论是 delegate、档位也没把它升级成询问、
      // 而回退策略又只是「再叫一个模型复核一次」（session / model）时，再为
      // `mandatory=unknown` 单独跑一次回退，等于给每条无法静态判定的本地命令
      // 稳定加倍一次模型调用——正是用户报告的「决策模型定不了论就回退」。
      //
      // 刻意**不**豁免的三种情况：
      //   - 外网/MCP 副作用（`external_network`）：边界在宿主之外，第二次独立
      //     复核是刻意保留的安全余量，不是冗余；
      //   - `baseAction` / `action` 是 ask，或主模型失效：这是软性判断本身要问，
      //     与原逻辑一致；
      //   - 显式 `allow` / `deny` 回退策略：那是用户写下的政策裁决，不能被这条
      //     豁免绕过（`allow` 会放行、`deny` 会拦截，都不是「多跑一次模型」）。
      const fallbackPolicy = GUARD_FALLBACKS.includes(config.guardFallback) ? config.guardFallback : "session";
      const localUnknownDeferOnly = effect.kind === "unknown" && effect.known === false
        && advisory?.status === "valid" && baseAction.kind === "delegate" && tolerated.kind === "delegate"
        && ["session", "model"].includes(fallbackPolicy);
      const unresolved = mandatory.status === "unknown" && !localUnknownDeferOnly;
      if (automaticReview(context, config) && (unresolved || baseAction.kind === "ask" || action.kind === "ask" || primary.status === "failed")) {
        action = await runFallback();
      } else if (primary.status === "failed") {
        action = { kind: context.approvalAvailable === true ? "ask" : "deny", reason: "advisory-failed-unknown-effect" };
      } else if (action.kind === "ask" && context.approvalPolicy === "never") {
        /**
         * 审批通道不存在（DSH 的 `never` = 每个 ask 确定性 rejected）。
         *
         * 1.13.0 现场问题（审计 P0-1）：只有「软性 ask」才走回退，模型对
         * `mandatory=safe` 的工作区写给出 high/注入判断时被直接 deny——
         * 本地静态规则已经确认了边界，却让一条模型意见把合法写操作中止。
         *
         * 现在：
         *   - `mandatory=safe`：交宿主沙箱（本地规则已判定工作区内安全）；
         *   - 其它（unknown / 非 safe）：交给用户配置的回退审查者，
         *     由它做唯一裁决；模型不可用或回退失败仍然 fail-closed。
         *
         * 强制约束（requires_approval / deny）在更早的位置已经返回，
         * 不会被这里绕过。
         */
        action = mandatory.status === "safe"
          ? { kind: "delegate", reason: "safe-local-operation-host-sandbox" }
          : await runFallback();
      }
      // 档位把「默认放行」升级成「询问」时，`action.reason` 是档位 note（含
      // `severity=` 与阈值小数）——那是审计口径，不能当审批卡标题。这里换成
      // 固定双语文案；note 仍进 `humanReason` / 遥测 detail，事后核对仍能看出
      // 是哪一档、什么分数。放在回退之后：回退给出的裁决有自己的文案。
      if (tolerated.changed && action.kind === "ask" && action.reasonCode === undefined) action = toleranceAskAction(action);
      // 记录本次裁决，供 120 秒内的同调用重试复用（仅无审批通道时生效）。
      if (context.approvalAvailable === false && ["delegate", "deny", "ask"].includes(action.kind)) {
        verdictMemo.set(memoKey, {
          at: Date.now(),
          kind: action.kind,
          reason: action.reason,
          reasonCode: action.reasonCode ?? "unclassified",
          humanReason: action.humanReason ?? action.reason,
          degradedReason,
        });
        if (verdictMemo.size > 512) verdictMemo.delete(verdictMemo.keys().next().value);
      }
      return finish(action, degradedReason);
    } catch {
      ctx.logger?.warn?.("decision-engine: guard failed; explicit permission constraints remain protected");
      if (pointMode === "off") return next();
      if (["safe", "unknown"].includes(mandatory?.status) && automaticReview(context, config)) return finish(await runFallback(), "guard-exception");
      return finish({ kind: ["safe", "unknown"].includes(mandatory?.status) && context?.approvalAvailable === true ? "ask" : "deny", reason: "guard-exception" }, "guard-exception");
    }
  };
  ctx.on("tools/pre-execute", listener);
  return listener;
}
