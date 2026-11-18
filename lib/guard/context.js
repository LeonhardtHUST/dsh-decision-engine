import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";

import { boundedDestructiveTarget } from "./effects.js";

export const TRUSTED_CONTEXT_VERSION = "guard-context-v1";

function rootService(ctx, name) {
  try { return ctx?.get?.(name); } catch { return undefined; }
}

export function guardService(ctx, agent, name, sources = {}) {
  const actor = agent?.ctx;
  if (actor) {
    const presets = rootService(ctx, "agentPresets");
    if (typeof presets?.serviceFor === "function") {
      try {
        const scoped = presets.serviceFor(agent, name);
        if (scoped !== undefined) { sources[name] = "preset"; return scoped; }
      } catch { sources[name] = "preset-error"; return undefined; }
    }
    if (typeof actor.get === "function") {
      try { sources[name] = "actor-host"; return actor.get(name); }
      catch { sources[name] = "actor-error"; return undefined; }
    }
    sources[name] = "actor-unavailable";
    return undefined;
  }
  sources[name] = "legacy-host";
  return rootService(ctx, name);
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
    destructiveTargetScope: "unknown",
    hostEnforcement: { file: "unknown", shell: "unknown", internalMessage: "unknown" },
    toolAccess: "unknown",
    messageTarget: { id: "unknown", membership: "unknown", continuable: "unknown", permissions: "unknown", downstreamIndependentApproval: "unknown" },
    availability,
    evidence,
    serviceSources: {},
  };
  const scopedService = (name) => guardService(ctx, agent, name, context.serviceSources);
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
  const presets = scopedService("permissionPresets");
  const presetName = await read("permissionPreset", () => session && presets?.current?.(session));
  if (typeof presetName === "string") context.permissionPreset = presetName;
  const preset = await read("permissionBundle", () => presetName && presets?.resolve?.(presetName));
  const approval = scopedService("approval");
  const override = await read("approvalOverride", () => session && approval?.overrideOf?.(session));
  const policy = override ?? preset?.approval;
  if (policy === "ask" || policy === "never") context.approvalPolicy = policy;
  context.approvalAvailable = policy === "never" ? false
    : policy === "ask" && typeof approval?.request === "function" ? true : "unknown";
  availability.approvalPolicy = { available: context.approvalPolicy !== "unknown", reason: override !== undefined ? "host-session-override" : preset?.approval ? "host-preset" : "host-default-unavailable" };
  const sandboxPolicy = scopedService("sandboxPolicy");
  const sandbox = await read("sandboxPolicy", () => session && sandboxPolicy?.resolve?.({ session }));
  const sandboxMode = sandbox?.mode ?? preset?.sandbox;
  if (["read-only", "workspace-write", "danger-full-access"].includes(sandboxMode)) context.sandboxMode = sandboxMode;
  if (typeof sandbox?.workspaceRoot === "string") {
    context.workspaceRoots = [sandbox.workspaceRoot, ...(sandbox.additionalWritableRoots ?? []).filter((root) => typeof root === "string")];
  }
  const tools = scopedService("tools");
  if (typeof tools?.executable === "function" && exec?.name) {
    const definition = await read("toolAccess", () => tools.executable(exec.name, agent, exec.toolSet));
    context.toolAccess = availability.toolAccess.available ? "available" : availability.toolAccess.reason === "host-field-unavailable" ? "denied" : "unknown";
    if (definition) evidence.push({ source: "tools.executable", field: "toolAccess", value: "available" });
  }
  const args = exec?.arguments;
  const fs = scopedService("fs");
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
  // 有界删除的宿主证据（形状解析见 effects.js `boundedDestructiveTarget`）。
  //
  // 命令形状成立 ≠ 目标在工作区内：相对路径、符号链接、工作区根本身、`.git`
  // 都要用宿主 fs 解析后的规范路径判断。拿不到解析/包含能力时保持 "unknown"，
  // policy 不会给豁免——缺证据等于没有证据，绝不用词法推断顶上。
  const destructiveTarget = ["pwsh", "bash", "shell"].includes(exec?.name)
    ? boundedDestructiveTarget({ toolName: exec.name, args })
    : undefined;
  if (destructiveTarget) {
    // 与宿主 pwsh/bash 工具相同的执行目录来源。header.cwd 只是初始目录，
    // sandbox.workspaceRoot 只是权限边界，两者都不能代替当前执行 cwd。
    // workdir 由调用方提供，只有经过宿主 shell.resolve 才能作为执行证据。
    const workingDirectory = scopedService("workingDirectory");
    const shell = scopedService("shell");
    const executionCwd = await read("destructiveExecutionCwd", async () => {
      if (!["pwsh", "bash"].includes(exec.name) || !agent
        || typeof workingDirectory?.ensure !== "function" || typeof shell?.resolve !== "function") return undefined;
      const cwd = await workingDirectory.ensure(agent, exec.signal);
      if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) throw new TypeError("invalid-execution-cwd");
      if (args.workdir !== undefined && (typeof args.workdir !== "string" || !args.workdir.trim())) return undefined;
      const workdir = args.workdir === undefined ? cwd : isAbsolute(args.workdir) ? args.workdir
        : exec.name === "pwsh" ? resolvePath(cwd, args.workdir) : `${cwd}${sep}${args.workdir}`;
      const spec = await shell.resolve({ command: args.command, workdir, signal: exec.signal,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(sandbox !== undefined ? { sandboxPolicy: sandbox } : {}),
      });
      if (typeof spec?.workdir !== "string" || !spec.workdir || !isAbsolute(spec.workdir)) throw new TypeError("invalid-resolved-execution-cwd");
      return spec.workdir;
    });
    if (executionCwd !== undefined) {
      context.destructiveExecutionCwd = executionCwd;
      evidence.push({ source: "workingDirectory.ensure+shell.resolve", field: "destructiveExecutionCwd", value: executionCwd, temporalScope: "pre-execution-snapshot" });
    }
    const location = await read("destructiveTargetScope", async () => {
      if (executionCwd === undefined || !context.workspaceRoots.length || typeof fs?.resolve !== "function" || typeof fs?.contains !== "function") return undefined;
      const resolve = async (path, cwd) => {
        const target = await fs.resolve(path, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
        if ((typeof target !== "string" || !target) && (target === null || typeof target !== "object" || Array.isArray(target))) throw new TypeError("invalid-resolved-target");
        return target;
      };
      const contains = (parent, child) => {
        const result = fs.contains(parent, child);
        if (typeof result !== "boolean") throw new TypeError("invalid-target-containment");
        return result;
      };
      const target = await resolve(destructiveTarget.target, executionCwd);
      const roots = await Promise.all(context.workspaceRoots.map((root) => resolve(root)));
      // 相等用双向包含判断，不能解析宿主的 opaque target handle。
      const same = (left, right) => contains(left, right) && contains(right, left);
      if (roots.some((root) => same(root, target))) return "protected";
      // 任一保护目录无法解析或 containment 无法判定，都由 read 保持 unknown。
      // 不允许把查询失败当成「不在保护目录」并继续 workspace/temp 豁免。
      for (const root of context.workspaceRoots) {
        const gitDir = await resolve(".git", root);
        if (contains(gitDir, target)) return "protected";
      }
      const temp = await resolve(tmpdir());
      if (same(temp, target)) return "protected";
      if (roots.some((root) => contains(root, target))) return "workspace";
      return contains(temp, target) ? "temp" : "outside";
    });
    if (typeof location === "string") {
      context.destructiveTargetScope = location;
      evidence.push({ source: "fs.resolve+contains", field: "destructiveTargetScope", value: location, temporalScope: "pre-execution-snapshot" });
    }
  }
  if (exec?.name === "send_message") {
    context.messageVerification = {
      senderId: agent?.id ?? session?.id,
      membership: "unknown", continuable: "unknown", hostLocal: "unknown",
      globalGuardRegistered: downstreamPolicyEnforced === true,
      downstreamIndependentApproval: "unknown",
      verificationStage: "input", verificationReason: "invalid-agent-argument",
    };
  }
  if (exec?.name === "send_message" && typeof args?.agent === "string") {
    const verification = context.messageVerification;
    const subagents = scopedService("subagents");
    const target = await read("messageTarget", async () => {
      if (!args.agent.trim()) return undefined;
      verification.verificationStage = "service";
      verification.verificationReason = "subagents-service-unavailable";
      if (!agent || typeof subagents?.rootOf !== "function" || typeof subagents?.resolveName !== "function" || typeof subagents?.listDescendants !== "function") return undefined;
      verification.verificationStage = "root";
      verification.verificationReason = "root-query-failed";
      const root = subagents.rootOf(agent);
      const rootId = root?.session?.id ?? root?.id;
      if (typeof rootId !== "string" || !rootId.trim()) {
        verification.verificationReason = "root-unavailable";
        return undefined;
      }
      verification.rootId = rootId;
      verification.verificationStage = "target";
      verification.verificationReason = "target-resolution-failed";
      const targetId = await subagents.resolveName(agent, args.agent, exec.signal);
      if (typeof targetId !== "string" || !targetId.trim()) throw new TypeError("invalid-target-id");
      verification.targetId = targetId;
      verification.verificationStage = "descendants";
      verification.verificationReason = "descendants-query-failed";
      const descendants = await subagents.listDescendants(rootId, exec.signal);
      if (!Array.isArray(descendants)) throw new TypeError("invalid-descendants");
      const member = descendants.find((entry) => entry.kind === "child" && entry.id === targetId && entry.mode === "continuable");
      const verified = targetId === rootId || Boolean(member);
      /**
       * 「目标是不是本机常驻成员」。
       *
       * 修之前只认 `agents.get(targetId)`——而 `agents` 只登记**活着的** Agent。
       * 于是给一个已空闲、但仍可接续的同一棵树的子代理发消息时：
       * `agents.get()` 返回 undefined → `hostLocal=false` →
       * `downstreamIndependentApproval="unknown"` → mandatory 判定
       * `requires_approval`，用户被问「无法核验接收方权限」。
       *
       * 实测这会让**所有**发给空闲队友的消息都弹审批（甚至审批策略为 never
       * 时被直接拒绝），而它们恰恰是宿主的 `subagents.sendMessage` 明确支持的
       * 「同树、可接续」目标。
       *
       * `listDescendants()` 读的是宿主自己的会话目录：目标出现在这里、且是
       * `continuable`，本身就是比「当前碰巧活着」更强的常驻证据。宿主在投递时
       * 还会再校验一次发送者/目标身份与可恢复性（`subagents.sendMessage` 会
       * 拒绝树外或不可恢复的目标），所以这里用目录成员补齐 hostLocal 不会放宽
       * 任何权限边界：一次性 / 外部子代理仍不在 `verified` 集合里。
       */
      verification.verificationStage = "host-local";
      verification.verificationReason = "host-local-query-failed";
      const resident = targetId === rootId ? root : scopedService("agents")?.get?.(targetId);
      const hostLocal = targetId === rootId
        || Boolean(member)
        || (resident?.id ?? resident?.session?.id) === targetId;
      const result = { id: targetId, membership: verified ? "same-tree" : "unknown", continuable: verified ? true : "unknown", hostLocal, permissions: "unknown", downstreamIndependentApproval: verified && hostLocal && downstreamPolicyEnforced === true ? true : "unknown" };
      Object.assign(verification, {
        membership: result.membership, continuable: result.continuable, hostLocal,
        downstreamIndependentApproval: result.downstreamIndependentApproval,
        verificationStage: !verified ? "descendants" : downstreamPolicyEnforced === true ? "complete" : "guard",
        verificationReason: !verified ? "target-not-in-continuable-tree" : downstreamPolicyEnforced === true ? "verified" : "guard-not-registered",
      });
      return result;
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
