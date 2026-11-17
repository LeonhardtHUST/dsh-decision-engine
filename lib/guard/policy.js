export const MANDATORY_STATUSES = ["safe", "requires_approval", "deny", "unknown"];

export function mandatoryApprovalDecision(mandatory, context = {}) {
  if (mandatory?.status !== "requires_approval") return undefined;
  /**
   * 原始强制约束原因必须随裁决一起带出去。
   *
   * `approval-policy-never` / `approval-channel-unavailable` 回答的是
   * 「为什么没走审批」，不是「为什么该拦」。若只记 `reason`，删除、越界写、
   * 收件人越权会被审计/统计归成同一桶，聚合里再也看不出真实约束。
   * `reason` 与用户文案/错误码保持不变，新增的 `policyBlockReason` 只做
   * 机器聚合口径（见 lib/guard/audit.js）。
   */
  const policyBlockReason = mandatory.reasonCodes?.[0] ?? "mandatory-policy-protected";
  if (context.approvalPolicy === "never") return { kind: "deny", reason: "approval-policy-never", policyBlockReason };
  if (mandatory.approvalAvailable !== true) return { kind: "deny", reason: "approval-channel-unavailable", policyBlockReason };
  return { kind: "ask", reason: policyBlockReason };
}

export function evaluateMandatoryPolicy({ context = {}, effect = {} } = {}) {
  const approvalAvailable = context.approvalAvailable ?? "unknown";
  const result = (status, reason) => ({
    status, reasonCodes: [reason], evidence: [...(effect.evidence ?? []), ...(context.evidence ?? [])], approvalAvailable,
  });
  if (context.toolAccess === "denied") return result("deny", "host-tool-access-denied");
  // 可证明无效的沙箱权限请求不是「待审批的提权」：宿主会在审批之前就以
  // SANDBOX_ESCALATION_INVALID_ARGUMENT 拒绝它。这里固定为 deny，既不发
  // native 审批也不交给模型，避免把「参数写错」误导成「换个策略就能过」。
  if (effect.kind === "invalid_request" && effect.known === true) return result("deny", "invalid-sandbox-permission-request");
  if (effect.kind === "read_local" && effect.known === true) return result("safe", "verified-local-query");
  if (effect.kind === "internal_state" && effect.known === true && effect.hostEnforced === true) return result("safe", "bounded-host-state-operation");
  if (effect.kind === "internal_message") {
    return effect.targetVerified === true && effect.hostEnforced === true && effect.downstreamIndependentApproval === true
      ? result("safe", "verified-internal-message-no-authority-transfer")
      : result("requires_approval", "recipient-authority-unverified");
  }
  if (effect.kind === "privileged") return result("requires_approval", "privilege-change-requires-approval");
  if (effect.kind === "destructive") return result("requires_approval", "destructive-operation-requires-approval");
  if (effect.kind === "write_workspace") {
    if (context.sandboxMode === "read-only") return result("requires_approval", "write-exceeds-read-only-permission");
    if (effect.canonical === "outside" || effect.scope === "outside-workspace") return result("requires_approval", "write-outside-authorized-workspace");
    if (["workspace-write", "danger-full-access"].includes(context.sandboxMode) && effect.canonical === "inside" && effect.known === true) {
      return result("safe", "bounded-canonical-workspace-write-defer-to-host");
    }
    return result("unknown", "workspace-write-authority-incomplete");
  }
  if (effect.kind === "external_network") return result("unknown", "external-effect-needs-model-review");
  if (effect.highImpact === true) return result("unknown", "unresolved-effect-needs-model-review");
  return result("unknown", "effect-or-permission-unverified");
}
