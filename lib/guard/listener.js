import { buildTrustedContext } from "./context.js";
import { classifyToolEffect } from "./effects.js";
import { evaluateMandatoryPolicy } from "./policy.js";
import { guardQuestions, parseModelAdvisory, decideModelAdvisory } from "./advisory.js";
import { createGuardAudit, hashSummary, joinHostOutcome } from "./audit.js";
import { classifyWorkspaceTarget } from "../scope.js";
import { resolveTolerance, severityOf, toleranceCutoff } from "../tolerance.js";
import { redactGuardData, reviewWithFallback } from "./fallback.js";

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

export function mountGuard(ctx, deps) {
  const { getConfig, reloadOwnConfig, effectivePointModes, client, toleranceCalibrator, digestRecent, previewArguments, logDecision, recordGuardDetail } = deps;
  const pending = new Map();
  let auditWriteFailures = 0;
  const mandatoryByToken = new Map();
  const toolService = ctx.get?.("tools");
  if (typeof toolService?.guard === "function") {
    const dispose = toolService.guard((exec) => {
      const config = getConfig();
      if (!config.enabled || config.guardEnabled === false || config.guardPolicyMode === "observe" || effectivePointModes(config).authorize !== "enforce") return;
      const recorded = mandatoryByToken.get(exec.token);
      if (recorded && (recorded.argsHash !== hashSummary(exec.arguments).sha256 || recorded.toolName !== exec.name || recorded.callId !== exec.callId || recorded.sessionId !== exec.agent?.session?.id)) {
        return { reason: "decision-engine: reviewed call identity changed", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_REVIEW_CHANGED" } };
      }
      if (recorded?.finalAction === "deny" || recorded?.finalAction === "cancel" || recorded?.status === "deny" || (recorded?.status === "requires_approval" && approvalOutcomeForCall(exec.agent?.session, exec.callId, exec.name, recorded.approvalAfterSeq) !== "allowed-once")) {
        return { reason: "decision-engine: mandatory denial cannot be overridden", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_MANDATORY_DENY" } };
      }
      if (!recorded) {
        const effect = classifyToolEffect({ toolName: exec.name, args: exec.arguments });
        if (effect.highImpact !== false) return { reason: "decision-engine: high-impact call has no mandatory review", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_MISSING_REVIEW" } };
      }
    });
    ctx.effect?.(() => dispose);
  }
  const keyOf = (exec) => `${exec.agent?.session?.id ?? "unknown"}:${exec.callId ?? "unknown"}`;
  const emit = async (audit) => {
    try {
      const persisted = await logDecision({ ts: new Date().toISOString(), point: "authorize", tag: "guard", action: audit.pluginReturnedAction ?? "unknown", audit, auditWriteFailures });
      if (persisted === false) { auditWriteFailures += 1; ctx.logger?.warn?.("decision-engine: guard audit persistence failed"); }
    } catch {
      auditWriteFailures += 1;
      ctx.logger?.warn?.("decision-engine: guard audit persistence failed");
    }
  };
  ctx.on("tools/result", (exec, result) => {
    const key = keyOf(exec);
    const audit = pending.get(key);
    if (!audit) return;
    pending.delete(key);
    const reviewed = mandatoryByToken.get(exec.token);
    mandatoryByToken.delete(exec.token);
    const approvalOutcome = approvalOutcomeForCall(exec.agent?.session, exec.callId, exec.name, reviewed?.approvalAfterSeq);
    void emit(joinHostOutcome(audit, { callId: exec.callId, sessionId: exec.agent?.session?.id, result, approvalOutcome }));
  });

  const listener = async (exec, next) => {
    let context;
    let effect;
    let mandatory;
    let result;
    let advisory;
    let baseAction;
    let tolerated;
    let fallback;
    let state;
    let questions;
    let pointMode = "off";
    let config;
    const session = exec.agent?.session;
    const finish = async (action, degradedReason) => {
      const observing = pointMode !== "enforce";
      const pluginReturnedAction = observing || action.kind === "delegate" ? "defer_to_host" : action.kind;
      const reviewed = mandatoryByToken.get(exec.token);
      if (reviewed && !observing) mandatoryByToken.set(exec.token, { ...reviewed, finalAction: action.kind });
      const audit = createGuardAudit({
        callId: exec.callId, sessionId: session?.id, toolName: exec.name, args: exec.arguments, questions,
        time: new Date().toISOString(), cacheStatus: result?.cached ? "hit" : "miss",
        context, effect, mandatory, advisory, baseAction: baseAction?.kind ?? action.kind,
        tolerance: tolerated, pluginReturnedAction, degradedReason: degradedReason ?? null,
        model: result?.model ?? fallback?.selection?.model ?? "unknown",
        provider: result?.provider ?? fallback?.selection?.provider ?? "unknown",
        cached: result?.cached === true,
      });
      const trace = { ...audit, callId: exec.callId ?? "unknown", sessionId: session?.id ?? "unknown", pluginReturnedAction, baseAction: baseAction?.kind ?? action.kind, tolerance: { ...audit.tolerance, level: config?.tolerance ?? "default" }, fallback: fallback ?? null, degradedReason: degradedReason ?? null };
      pending.set(keyOf(exec), trace);
      if (pending.size > 2048) pending.delete(pending.keys().next().value);
      await emit(trace);
      try {
        client.recordDecision({ facts: result?.statsFacts, action: action.kind, detail: action.reason ?? action.kind, degraded: Boolean(degradedReason) });
      } catch { ctx.logger?.warn?.("decision-engine: guard statistics unavailable"); }
      const scores = {
        risk_p: advisory?.risk?.confidence ?? null,
        raw_decision_confidence: advisory?.risk?.confidence ?? null,
        confidenceKind: advisory?.risk?.confidenceKind ?? advisory?.confidenceKind ?? "unavailable",
        p_high: advisory?.risk?.probabilities?.high ?? null,
        p_non_low: advisory?.risk?.probabilities ? advisory.risk.probabilities.high + advisory.risk.probabilities.medium : null,
        risk_severity: tolerated?.severity ?? null,
        calibrated_p_unsafe: null,
        mandatory: mandatory?.status ?? "unknown",
        tolerance: tolerated ?? null,
      };
      recordGuardDetail({ session, pointMode, exec, state: { summary: hashSummary(state), contextVersion: context?.contextVersion ?? "unknown", effect: effect?.kind ?? "unknown", mandatory: mandatory?.status ?? "unknown" }, questions: { summary: hashSummary(questions), version: advisory?.metadata?.questionsVersion ?? "unknown" }, result: result ? { ...result, answers: { summary: hashSummary(result.answers), model_result: audit.model_result } } : undefined, action: action.kind, detail: action.reason ?? action.kind, degraded: Boolean(degradedReason), scores });
      if (observing || action.kind === "delegate") return next();
      if (action.kind === "cancel") return { kind: "cancel" };
      if (action.kind === "deny") return { kind: "deny", reason: action.reason ?? "decision-engine: mandatory policy denied", info: { name: "DecisionEngineGuardError", code: "DECISION_ENGINE_GUARD_DENY" } };
      return { kind: "ask", reason: action.reason ?? "decision-engine: requires approval", ...(action.displayReason ? { displayReason: action.displayReason } : {}) };
    };
    try {
      await reloadOwnConfig();
      config = getConfig();
      if (!config.enabled || config.guardEnabled === false) return next();
      pointMode = effectivePointModes(config).authorize ?? "off";
      if (pointMode === "off") return next();
      if (exec.signal?.aborted) return finish({ kind: "cancel" });
      context = await buildTrustedContext({ agent: exec.agent, ctx, exec, host: { downstreamPolicyEnforced: pointMode === "enforce" && config.guardPolicyMode !== "observe" && typeof toolService?.guard === "function" } });
      const scope = classifyWorkspaceTarget({ tool: exec.name, args: exec.arguments, roots: context.workspaceRoots, cwd: context.cwd ?? session?.header?.cwd });
      effect = classifyToolEffect({ toolName: exec.name, args: exec.arguments, trustedContext: context, scope });
      mandatory = evaluateMandatoryPolicy({ context, effect });
      if (exec.token !== undefined) {
        let approvalAfterSeq;
        try {
          approvalAfterSeq = session.snapshotEvents().reduce((last, event) => Number.isFinite(event.seq) ? Math.max(last, event.seq) : last, -1);
        } catch { approvalAfterSeq = undefined; }
        mandatoryByToken.set(exec.token, { ...mandatory, approvalAfterSeq, argsHash: hashSummary(exec.arguments).sha256, toolName: exec.name, callId: exec.callId, sessionId: session?.id });
        if (mandatoryByToken.size > 2048) mandatoryByToken.delete(mandatoryByToken.keys().next().value);
      }
      const enforcingPolicy = config.guardPolicyMode !== "observe";
      if (enforcingPolicy && mandatory.status === "deny") return finish({ kind: "deny", reason: mandatory.reasonCodes.join(", ") });
      if (enforcingPolicy && mandatory.status === "requires_approval") {
        return finish({ kind: mandatory.approvalAvailable === true ? "ask" : "deny", reason: mandatory.reasonCodes.join(", ") });
      }
      if (mandatory.status === "safe" && ["read_local", "internal_message", "internal_state"].includes(effect.kind)) {
        return finish({ kind: "delegate", reason: "verified-local-operation-defer-to-host" });
      }
      state = redactGuardData({
        tool: exec.name,
        args_preview: previewArguments(redactGuardData(exec.arguments), config.argsHeadChars, config.argsTailChars),
        recent: digestRecent(session, config.recentMessages, config.recentMessageChars),
        recentAuthority: "untrusted-context-only",
        trustedContext: { originalUserGoal: context.originalUserGoal ?? "unknown", goalSource: context.goalSource },
        goalSource: context.goalSource,
        effect: { kind: effect.kind, scope: scope.kind },
        authorization: { mandatory: mandatory.status, approvalPolicy: context.approvalPolicy, sandboxMode: context.sandboxMode },
        contextVersion: context.contextVersion,
      });
      const budget = Math.max(500, Number(config.maxStateChars) || 6000);
      const sliceBudget = Math.floor(budget / 5);
      state.recent = String(state.recent ?? "").slice(0, sliceBudget);
      state.args_preview = String(state.args_preview ?? "").slice(0, sliceBudget);
      state.trustedContext.originalUserGoal = String(state.trustedContext.originalUserGoal).slice(0, sliceBudget);
      questions = guardQuestions();
      result = await client.classify({ point: "authorize", tag: "guard", mode: config.mode, pointMode, tool: exec.name, state, questions, signal: exec.signal });
      const degradedReason = result === null || result?.degraded ? result?.degraded ?? "classify-unavailable" : null;
      advisory = degradedReason ? undefined : parseModelAdvisory(result.answers);
      baseAction = advisory?.status === "valid" ? decideModelAdvisory(advisory, config) : { kind: "ask", reason: "advisory-unavailable" };
      const severity = advisory?.status === "valid" ? severityOf(advisory, { injectionFloorThreshold: config.guardInjectionAskThreshold }) : 1;
      if (advisory?.status === "valid") toleranceCalibrator.observe(result.provider ?? "", result.model, severity);
      const cutoffInfo = toleranceCutoff({ level: config.tolerance, calibrator: toleranceCalibrator, provider: result?.provider ?? "", model: result?.model });
      tolerated = resolveTolerance({ level: config.tolerance, legacyKind: baseAction.kind, severity, cutoff: cutoffInfo.cutoff, mandatory: enforcingPolicy ? mandatory : undefined, approvalAvailable: context.approvalAvailable });
      let action = tolerated.kind === baseAction.kind ? baseAction : { kind: tolerated.kind, reason: tolerated.note };
      const automatic = context.permissionPreset === "auto" || config.tolerance === "autonomous";
      if (automatic && (baseAction.kind === "ask" || degradedReason || advisory?.status !== "valid")) {
        fallback = await reviewWithFallback({ config, context, mandatory: enforcingPolicy ? mandatory : undefined, state, advisory, session, llm: ctx.get?.("llm"), signal: exec.signal });
        action = fallback;
      } else if (advisory?.status !== "valid" && mandatory.status !== "safe") {
        action = { kind: context.approvalAvailable === true ? "ask" : "deny", reason: "advisory-failed-unknown-effect" };
      }
      return finish(action, degradedReason ?? (advisory?.status !== "valid" ? "answer-shape-mismatch" : undefined));
    } catch {
      ctx.logger?.warn?.("decision-engine: guard failed; unsafe or unknown effects remain closed");
      if (pointMode === "off") return next();
      if (mandatory?.status === "safe" && (context?.permissionPreset === "auto" || config?.tolerance === "autonomous")) {
        fallback = await reviewWithFallback({ config, context, mandatory, state: state ?? { tool: exec.name }, session, llm: ctx.get?.("llm"), signal: exec.signal });
        return finish(fallback, "guard-exception");
      }
      return finish({ kind: mandatory?.status === "safe" && context?.approvalAvailable === true ? "ask" : "deny", reason: "guard-exception" }, "guard-exception");
    }
  };
  ctx.on("tools/pre-execute", listener);
  return listener;
}
