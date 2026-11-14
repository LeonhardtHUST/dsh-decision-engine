export const MANDATORY_STATUSES = ["safe", "requires_approval", "deny", "unknown"];

export function evaluateMandatoryPolicy({ context = {}, effect = {} } = {}) {
  const approvalAvailable = context.approvalAvailable ?? "unknown";
  const result = (status, reason) => ({
    status, reasonCodes: [reason], evidence: [...(effect.evidence ?? []), ...(context.evidence ?? [])], approvalAvailable,
  });
  if (context.toolAccess === "denied") return result("deny", "host-tool-access-denied");
  if (effect.kind === "read_local" && effect.known === true) return result("safe", "verified-local-query");
  if (effect.kind === "internal_state" && effect.known === true && effect.hostEnforced === true) return result("safe", "bounded-host-state-operation");
  if (effect.kind === "internal_message") {
    return effect.targetVerified === true && effect.hostEnforced === true && effect.downstreamIndependentApproval === true
      ? result("safe", "verified-internal-message-no-authority-transfer")
      : result("requires_approval", "recipient-authority-unverified");
  }
  if (["privileged", "destructive"].includes(effect.kind)) return result("requires_approval", "high-impact-requires-explicit-approval");
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
