import { createHash } from "node:crypto";
import { recordVersionFields } from "../plugin-meta.js";

export const GUARD_AUDIT_VERSION = "guard-audit-v1";

function canonical(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("cyclic-audit-input");
  seen.add(value);
  const result = Array.isArray(value) ? value.map((entry) => canonical(entry, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], seen)]));
  seen.delete(value);
  return result;
}

export function hashSummary(value) {
  try {
    const text = JSON.stringify(canonical(value));
    if (text === undefined) return { sha256: "unknown", bytes: "unknown" };
    return { sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return { sha256: "unknown", bytes: "unknown" };
  }
}

const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const actionOf = (value) => ["delegate", "ask", "deny", "defer_to_host"].includes(value?.kind ?? value) ? value?.kind ?? value : "unknown";
const identifier = (value) => typeof value === "string" && value ? value : "unknown";

const verificationStages = ["input", "service", "root", "target", "descendants", "host-local", "guard", "complete"];
const verificationReasons = ["invalid-agent-argument", "subagents-service-unavailable", "root-unavailable", "root-query-failed", "target-resolution-failed", "descendants-query-failed", "host-local-query-failed", "target-not-in-continuable-tree", "guard-not-registered", "verified"];
const booleanOrUnknown = (value) => typeof value === "boolean" ? value : "unknown";
const idHash = (value) => typeof value === "string" && value && value !== "unknown" ? hashSummary(value).sha256 : "unknown";

export function messageVerificationSummary(context = {}) {
  const verification = context?.messageVerification ?? {};
  return {
    senderIdHash: idHash(verification.senderId),
    rootIdHash: idHash(verification.rootId),
    targetIdHash: idHash(verification.targetId),
    membership: verification.membership === "same-tree" ? "same-tree" : "unknown",
    continuable: booleanOrUnknown(verification.continuable),
    hostLocal: booleanOrUnknown(verification.hostLocal),
    globalGuardRegistered: booleanOrUnknown(verification.globalGuardRegistered),
    downstreamIndependentApproval: booleanOrUnknown(verification.downstreamIndependentApproval),
    verificationStage: verificationStages.includes(verification.verificationStage) ? verification.verificationStage : "unknown",
    verificationReason: verificationReasons.includes(verification.verificationReason) ? verification.verificationReason : "unknown",
  };
}

export function createGuardAudit(options = {}) {
  const context = options.context ?? options.trustedContext ?? {};
  const advisory = options.advisory ?? {};
  const mandatory = options.mandatory ?? {};
  const effect = options.effect ?? {};
  return {
    ...recordVersionFields(GUARD_AUDIT_VERSION),
    call_id: identifier(options.callId ?? options.call_id),
    session_id: identifier(options.sessionId ?? context.sessionId),
    time: options.time ?? "unknown",
    context_version: context.contextVersion ?? "unknown",
    tool_name: identifier(options.toolName),
    ...(options.toolName === "send_message" ? { messageVerification: messageVerificationSummary(context) } : {}),
    args_summary: hashSummary(options.args),
    goal_summary: hashSummary(context.originalUserGoal),
    context_summary: hashSummary(context),
    questions_summary: hashSummary(options.questions ?? {}),
    questions_version: options.questionsVersion ?? advisory.metadata?.questionsVersion ?? "not_requested",
    model_summary: hashSummary(options.modelEvaluation ?? options.model ?? null),
    modelEvaluation: options.modelEvaluation ?? { status: "not_requested" },
    decisionSource: options.decisionSource ?? "local_policy",
    // 稳定的机器口径：聚合按 reasonCode，人读文案在明细/遥测的 detail。
    // 复用裁决也要能看出「这次是复用」，否则重试会把来源洗成 local_policy。
    reasonCode: typeof options.reasonCode === "string" && options.reasonCode ? options.reasonCode : "unknown",
    /**
     * 被强制权限约束拦下时的**原始**原因枚举（destructive / write-outside /
     * recipient-authority …），与 `reasonCode` 分开。
     *
     * `reasonCode` 仍回答「这次为什么得到这个裁决」——approval-policy-never
     * 是审批可用性原因；`policyBlockReason` 回答「哪条强制约束触发了拦截」。
     * 只有前者时，never 下所有强制拦截会在聚合里并成同一 reasonCode。
     */
    policyBlockReason: identifier(options.policyBlockReason),
    reused: options.reused === true,
    model_result: {
      status: options.modelEvaluation?.primary?.status ?? advisory.status ?? "not_requested",
      risk: ["low", "medium", "high"].includes(advisory.risk?.choice) ? advisory.risk.choice : "unknown",
      confidenceKind: ["normalized", "provider_raw", "unavailable"].includes(advisory.metadata?.confidenceKind) ? advisory.metadata.confidenceKind : "unavailable",
      raw_decision_confidence: finite(advisory.metadata?.raw_decision_confidence),
      p_high: finite(advisory.metadata?.p_high),
      p_non_low: finite(advisory.metadata?.p_non_low),
      irreversibleP: finite(advisory.irreversibleP), taskP: finite(advisory.taskP), injectionP: finite(advisory.injectionP),
      calibrated_p_unsafe: "unknown",
      validationErrors: advisory.errors ?? [],
      metadataWarnings: advisory.metadata?.warnings ?? [],
      probabilityStatus: advisory.metadata?.probabilityStatus ?? "unavailable",
      raw_class_probabilities: advisory.metadata?.raw_class_probabilities ?? null,
    },
    mandatory: { status: ["safe", "requires_approval", "deny", "unknown"].includes(mandatory.status) ? mandatory.status : "unknown", reasonCodes: mandatory.reasonCodes ?? [], evidence_summary: hashSummary(mandatory.evidence) },
    effect: { kind: effect.kind ?? "unknown", highImpact: effect.highImpact ?? "unknown", summary: hashSummary(effect) },
    permission: { permissionPreset: context.permissionPreset ?? "unknown", serviceSources: context.serviceSources ?? {}, approvalPolicy: context.approvalPolicy ?? "unknown", approvalAvailable: context.approvalAvailable ?? "unknown", sandboxMode: context.sandboxMode ?? "unknown" },
    baseAction: actionOf(options.baseAction),
    tolerance: { level: options.tolerance?.level ?? "unknown", changed: options.tolerance?.changed ?? "unknown", action: actionOf(options.tolerance?.kind), severity: finite(options.tolerance?.severity), severityMeaning: "ranking-score-not-calibrated-probability" },
    pluginReturnedAction: actionOf(options.pluginReturnedAction),
    hostApprovalStatus: "unknown",
    hostFinalAction: "unknown",
    effectOutcome: "unknown",
    degradedReason: options.degradedReason ?? "unknown",
    cacheStatus: options.cacheStatus ?? "unknown",
  };
}

export function joinHostOutcome(audit, outcome = {}) {
  if (!audit || outcome.callId !== audit.call_id || outcome.sessionId !== audit.session_id) return audit;
  const joined = { ...audit };
  if (["allowed-once", "rejected", "cancelled", "unavailable", "policy_auto_rejected"].includes(outcome.approvalOutcome)) joined.hostApprovalStatus = outcome.approvalOutcome;
  if (["allow", "deny", "cancelled", "error", "policy_auto_rejected"].includes(outcome.hostFinalAction)) joined.hostFinalAction = outcome.hostFinalAction;
  if (outcome.result?.isError === false) joined.effectOutcome = "reported-success";
  if (outcome.result?.isError === true) joined.effectOutcome = "reported-error";
  return joined;
}
