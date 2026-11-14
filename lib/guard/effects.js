export const TOOL_EFFECT_KINDS = ["read_local", "write_workspace", "internal_message", "internal_state", "external_network", "privileged", "destructive", "unknown"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(args, allowed, required = []) {
  return object(args) && Object.keys(args).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(args, key));
}

function strings(args, names) {
  return names.every((name) => args[name] === undefined || typeof args[name] === "string");
}

export function classifyToolEffect({ toolName, args, trustedContext = {}, scope } = {}) {
  const effect = {
    kind: "unknown", known: false, highImpact: true, hostEnforced: "unknown",
    scope: scope?.kind ?? "unknown", canonical: "unknown", recoverability: "unknown",
    reasonCodes: ["unknown-tool-effect"], evidence: [],
  };
  const known = (kind, reason, extra = {}) => ({ ...effect, kind, known: true, highImpact: false, reasonCodes: [reason], evidence: [{ source: "strict-local-tool-contract", toolName }], ...extra });
  if (!object(args)) return { ...effect, reasonCodes: ["invalid-tool-arguments"] };
  if (Object.hasOwn(args, "sandbox_permissions") && args.sandbox_permissions !== undefined) {
    return known("privileged", "explicit-permission-escalation", { highImpact: true });
  }
  if (toolName === "list_agents" && fields(args, [])) return known("read_local", "known-agent-tree-query", { recoverability: "no-mutation" });
  if (["team_task_list", "team_task_get", "get_goal", "job_list"].includes(toolName)) {
    const schemas = {
      team_task_list: ["status", "owner", "unowned", "ready", "cursor", "limit"],
      team_task_get: ["task_id"], get_goal: [], job_list: [],
    };
    if (fields(args, schemas[toolName], toolName === "team_task_get" ? ["task_id"] : []) && strings(args, ["task_id", "owner", "status"])
      && ["unowned", "ready"].every((key) => args[key] === undefined || typeof args[key] === "boolean")
      && ["cursor", "limit"].every((key) => args[key] === undefined || (Number.isSafeInteger(args[key]) && args[key] >= 0))
      && (args.status === undefined || ["pending", "in_progress", "completed"].includes(args.status))) {
      return known("read_local", "known-local-state-query", { recoverability: "no-mutation" });
    }
  }
  if (toolName === "working_directory" && fields(args, [])) return known("read_local", "working-directory-query", { recoverability: "no-mutation" });
  if (toolName === "skill" && fields(args, ["name"], ["name"]) && typeof args.name === "string") return known("read_local", "known-skill-document-query", { recoverability: "no-mutation" });
  if (toolName === "cordis_inspect_list" && fields(args, [])) return known("read_local", "known-runtime-schema-query", { recoverability: "no-mutation" });
  if (toolName === "list_subagent_models" && fields(args, ["provider", "model"]) && strings(args, ["provider", "model"])) return known("read_local", "known-model-route-query", { recoverability: "no-mutation" });
  if (toolName === "cordis_inspect_query" && fields(args, ["platform", "provider", "method", "input"], ["platform", "provider", "method"]) && ["host", "client"].includes(args.platform) && strings(args, ["provider", "method"])) return known("read_local", "known-runtime-schema-query", { recoverability: "no-mutation" });
  if (["read", "read_image", "glob", "grep"].includes(toolName)) {
    const schemas = {
      read: ["file_path", "offset", "limit"], read_image: ["file_path"],
      glob: ["path", "pattern"], grep: ["path", "pattern", "include"],
    };
    const required = [toolName === "glob" || toolName === "grep" ? "pattern" : "file_path"];
    if (fields(args, schemas[toolName], required) && strings(args, ["file_path", "path", "pattern", "include"]) && ["limit", "offset"].every((key) => args[key] === undefined || Number.isFinite(args[key]))) {
      return known("read_local", "known-local-file-query", { recoverability: "no-mutation" });
    }
  }
  if (toolName === "team_task_update" && fields(args, ["task_id", "expected_revision", "action", "subject", "description", "blocked_by", "write_scopes", "owner"], ["task_id", "expected_revision", "action"])
    && typeof args.task_id === "string" && Number.isSafeInteger(args.expected_revision) && args.expected_revision >= 0
    && ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"].includes(args.action)) {
    return known("internal_state", "bounded-team-task-state", { recoverability: "host-revisioned", hostEnforced: true });
  }
  if (toolName === "todo_write" && fields(args, ["todos"], ["todos"]) && Array.isArray(args.todos)
    && args.todos.every((todo) => fields(todo, ["content", "status"], ["content", "status"]) && typeof todo.content === "string" && ["pending", "in_progress", "completed"].includes(todo.status))) {
    return known("internal_state", "bounded-todo-state", { recoverability: "replaceable", hostEnforced: true });
  }
  if (toolName === "send_message" && fields(args, ["agent", "message"], ["agent", "message"]) && typeof args.agent === "string" && typeof args.message === "string") {
    const target = trustedContext.messageTarget;
    const verified = target?.membership === "same-tree" && target.continuable === true && target.downstreamIndependentApproval === true;
    return known("internal_message", verified ? "verified-internal-recipient" : "unverified-internal-recipient", {
      highImpact: !verified, hostEnforced: verified && trustedContext.hostEnforcement?.internalMessage === true,
      targetVerified: verified, downstreamIndependentApproval: target?.downstreamIndependentApproval ?? "unknown", targetPermissions: "unknown", recoverability: "message-not-retractable",
    });
  }
  if (["web_fetch", "web_search"].includes(toolName) || toolName?.startsWith("mcp__")) {
    return { ...effect, kind: "external_network", reasonCodes: ["external-capability-not-locally-authorized"] };
  }
  if (["write", "edit"].includes(toolName)) {
    const allowed = toolName === "write" ? ["file_path", "content"] : ["file_path", "old_string", "new_string", "replace_all"];
    const required = toolName === "write" ? allowed : ["file_path", "old_string", "new_string"];
    if (fields(args, allowed, required) && strings(args, ["file_path", "content", "old_string", "new_string"]) && (args.replace_all === undefined || typeof args.replace_all === "boolean")) {
      return known("write_workspace", "bounded-file-mutation", {
        highImpact: trustedContext.fileTargetScope !== "inside", canonical: trustedContext.fileTargetScope,
        hostEnforced: trustedContext.hostEnforcement?.file ?? "unknown", recoverability: "unknown",
      });
    }
  }
  if (["pwsh", "bash", "shell"].includes(toolName) && typeof args.command === "string") {
    const command = args.command;
    if (/(?:^|[\s;&|])(?:sudo|runas|Set-Acl|takeown|icacls)(?:\s|$)/i.test(command)) {
      return known("privileged", "possible-shell-privilege-change", { highImpact: true });
    }
    if (/(?:^|[\s;&|])(?:rm|rmdir|del|Remove-Item|Clear-Content|Format-Volume|diskpart|shred)(?:\s|$)|git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i.test(command)) {
      return known("destructive", "possible-shell-destructive-effect", { highImpact: true });
    }
    if (/(?:^|[\s;&|])(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|scp|sftp|ssh)(?:\s|$)/i.test(command)) {
      return { ...effect, kind: "external_network", reasonCodes: ["possible-shell-external-effect"] };
    }
    return { ...effect, reasonCodes: ["unparsed-high-impact-execution"] };
  }
  if (toolName === "apply_patch") {
    const patch = args.input ?? args.patch;
    if (typeof patch === "string") return known("write_workspace", "patch-file-mutation", { highImpact: true, canonical: "unknown" });
    return { ...effect, reasonCodes: ["unparsed-multi-file-mutation"] };
  }
  return effect;
}
