import { createHash } from "node:crypto";

export const TRUSTED_CONTEXT_VERSION = "guard-context-v1";

function service(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

function textOf(message) {
  if (!Array.isArray(message?.content)) return undefined;
  const text = message.content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  return text || undefined;
}

export async function buildTrustedContext({ agent, ctx, exec, host = {}, downstreamPolicyEnforced = host.downstreamPolicyEnforced === true } = {}) {
  const session = agent?.session;
  const availability = {};
  const evidence = [];
  const context = {
    sessionId: session?.id ?? agent?.id ?? "unknown",
    callerAgentId: agent?.id ?? session?.id ?? "unknown",
    originalUserGoal: undefined,
    goalSource: "unknown",
    provenance: "unknown",
    permissionPreset: "unknown",
    approvalPolicy: "unknown",
    approvalAvailable: "unknown",
    sandboxMode: "unknown",
    workspaceRoots: [],
    delegatedScope: "unknown",
    targetPermissions: "unknown",
    fileTargetScope: "unknown",
    hostEnforcement: { file: "unknown", shell: "unknown", internalMessage: "unknown" },
    toolAccess: "unknown",
    messageTarget: { id: "unknown", membership: "unknown", continuable: "unknown", permissions: "unknown", downstreamIndependentApproval: "unknown" },
    availability,
    evidence,
  };
  const read = async (field, operation) => {
    try {
      const value = await operation();
      availability[field] = { available: value !== undefined, reason: value === undefined ? "host-field-unavailable" : "host-observed" };
      return value;
    } catch {
      availability[field] = { available: false, reason: "host-query-failed" };
      return undefined;
    }
  };
  const events = await read("originalUserGoal", () => session?.snapshotEvents?.());
  if (Array.isArray(events)) {
    const original = events.find((event) => event?.type === "user/message" && event.data?.source?.kind === "user" && textOf(event.data));
    if (original) {
      context.originalUserGoal = textOf(original.data);
      context.goalSource = "host-user";
      evidence.push({ source: "session.snapshotEvents", field: "originalUserGoal", seq: original.seq ?? "unknown" });
    } else {
      availability.originalUserGoal = { available: false, reason: "no-host-user-message" };
    }
  }
  const presets = service(ctx, "permissionPresets");
  const presetName = await read("permissionPreset", () => session && presets?.current?.(session));
  if (typeof presetName === "string") context.permissionPreset = presetName;
  const preset = await read("permissionBundle", () => presetName && presets?.resolve?.(presetName));
  const approval = service(ctx, "approval");
  const override = await read("approvalOverride", () => session && approval?.overrideOf?.(session));
  const policy = override ?? preset?.approval;
  if (policy === "ask" || policy === "never") context.approvalPolicy = policy;
  context.approvalAvailable = policy === "never" ? false
    : policy === "ask" && typeof approval?.request === "function" ? true : "unknown";
  availability.approvalPolicy = { available: context.approvalPolicy !== "unknown", reason: override !== undefined ? "host-session-override" : preset?.approval ? "host-preset" : "host-default-unavailable" };
  const sandboxPolicy = service(ctx, "sandboxPolicy");
  const sandbox = await read("sandboxPolicy", () => session && sandboxPolicy?.resolve?.({ session }));
  const sandboxMode = sandbox?.mode ?? preset?.sandbox;
  if (["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode)) context.sandboxMode = sandboxMode;
  if (typeof sandbox?.workspaceRoot === "string") {
    context.workspaceRoots = [sandbox.workspaceRoot, ...(sandbox.additionalWritableRoots ?? []).filter((root) => typeof root === "string")];
  }
  const tools = service(ctx, "tools");
  if (typeof tools?.executable === "function" && exec?.name) {
    const definition = await read("toolAccess", () => tools.executable(exec.name, agent, exec.toolSet));
    context.toolAccess = availability.toolAccess.available ? "available" : availability.toolAccess.reason === "host-field-unavailable" ? "denied" : "unknown";
    if (definition) evidence.push({ source: "tools.executable", field: "toolAccess", value: "available" });
  }
  const args = exec?.arguments;
  const fs = service(ctx, "fs");
  if (["write", "edit"].includes(exec?.name) && typeof args?.file_path === "string" && context.workspaceRoots.length && typeof fs?.resolve === "function" && typeof fs?.contains === "function") {
    const contained = await read("fileTargetScope", async () => {
      const target = await fs.resolve(args.file_path, { cwd: context.workspaceRoots[0], signal: exec.signal });
      const roots = await Promise.all(context.workspaceRoots.map((root) => fs.resolve(root, { signal: exec.signal })));
      return roots.some((root) => fs.contains(root, target));
    });
    if (typeof contained === "boolean") {
      context.fileTargetScope = contained ? "inside" : "outside";
      evidence.push({ source: "fs.resolve+contains", field: "fileTargetScope", value: context.fileTargetScope, temporalScope: "pre-execution-snapshot" });
    }
  }
  if (exec?.name === "send_message" && typeof args?.agent === "string") {
    const subagents = service(ctx, "subagents");
    const target = await read("messageTarget", async () => {
      if (!agent || typeof subagents?.rootOf !== "function" || typeof subagents?.resolveName !== "function" || typeof subagents?.listDescendants !== "function") return undefined;
      const root = subagents.rootOf(agent);
      const rootId = root?.session?.id ?? root?.id;
      if (!rootId) return undefined;
      const targetId = await subagents.resolveName(agent, args.agent, exec.signal);
      const descendants = await subagents.listDescendants(rootId, exec.signal);
      const member = descendants.find((entry) => entry.kind === "child" && entry.id === targetId && entry.mode === "continuable");
      const verified = targetId === rootId || Boolean(member);
      const resident = targetId === rootId ? root : service(ctx, "agents")?.get?.(targetId);
      const hostLocal = (resident?.id ?? resident?.session?.id) === targetId;
      return { id: targetId, membership: verified ? "same-tree" : "unknown", continuable: verified ? true : "unknown", hostLocal, permissions: "unknown", downstreamIndependentApproval: verified && hostLocal && downstreamPolicyEnforced === true ? true : "unknown" };
    });
    if (target) {
      context.messageTarget = target;
      if (target.downstreamIndependentApproval === true) evidence.push({ source: "global-guard-registration", field: "downstreamIndependentApproval", value: true });
      if (target.membership === "same-tree") {
        context.hostEnforcement.internalMessage = true;
        evidence.push({ source: "subagents.rootOf+resolveName+listDescendants", field: "messageTarget", value: "same-tree" });
      }
    }
  }
  context.contextVersion = `${TRUSTED_CONTEXT_VERSION}:${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`;
  return context;
}
