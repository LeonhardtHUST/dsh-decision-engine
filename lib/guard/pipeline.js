import { redactGuardData } from "./fallback.js";

export const idleEvaluation = () => ({ status: "not_requested", provider: null, model: null, latencyMs: null, reason: null });

/**
 * 记忆命中时的模型评估标记。
 *
 * 复用裁决没有真的再调一次模型，但裁决本身来自模型；两者都要如实写进审计：
 * 保留 provider/model（来源可追溯），把**成功**的评估标成 `cache_hit` 并清掉
 * 延迟（这次没有网络往返）。`failed` 不能改写成 `cache_hit`，否则复用会把
 * 首次的模型失败率洗掉；失败状态原样保留，复用仍由 `reused`/`cacheStatus` 表达。
 */
export const reuseEvaluation = (evaluation) => evaluation.status === "completed" || evaluation.status === "cache_hit"
  ? { ...evaluation, status: "cache_hit", latencyMs: null }
  : evaluation;

export function interruptedReviewAction({ aborted, mandatory }) {
  return aborted
    ? { kind: "cancel", reason: "review-cancelled" }
    : { kind: mandatory?.status === "safe" ? "delegate" : "deny", reason: "review-timeout", reasonCode: "review-timeout" };
}

export function createVerdictMemoEntry({ at, verdict, primary, secondary, decisionSource, baseAction, fallback, degradedReason }) {
  return {
    at,
    verdict,
    primary,
    secondary,
    decisionSource,
    baseAction: baseAction?.kind ?? verdict.kind,
    fallback: fallback ?? null,
    degradedReason,
  };
}

export function buildModelReviewState({ state, argsPreview, recent, context, config }) {
  const reviewState = redactGuardData({ ...state, args_preview: argsPreview, recent, recentAuthority: "untrusted-context-only", trustedContext: { originalUserGoal: context.originalUserGoal ?? "unknown", goalSource: context.goalSource } });
  const sliceBudget = Math.floor(Math.max(500, Number(config.maxStateChars) || 6000) / 5);
  reviewState.recent = String(reviewState.recent ?? "").slice(0, sliceBudget);
  reviewState.args_preview = String(reviewState.args_preview ?? "").slice(0, sliceBudget);
  reviewState.trustedContext.originalUserGoal = String(reviewState.trustedContext.originalUserGoal).slice(0, sliceBudget);
  return reviewState;
}

export function summarizeModelEvaluation(primary, secondary) {
  const requested = [primary, secondary].filter((evaluation) => evaluation.status !== "not_requested");
  const modelEvaluation = { status: requested.length ? (requested.at(-1).status === "failed" ? "failed" : "completed") : "not_requested", primary, fallback: secondary };
  const judge = secondary.provider || secondary.model ? secondary : primary;
  const latencyMs = requested.length ? requested.reduce((total, evaluation) => total + (evaluation.latencyMs ?? 0), 0) : null;
  return { requested, modelEvaluation, judge, latencyMs };
}
