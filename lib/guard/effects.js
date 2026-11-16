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

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalStringArray(value) {
  return value === undefined || (Array.isArray(value) && value.every(nonemptyString));
}

function integerIn(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

const POWERSHELL_READ_CONTRACTS = {
  "get-location": { switches: [] },
  "get-date": { switches: ["-asutc"] },
  "get-process": { switches: [], values: { "-id": "integer", "-name": "name" } },
  "get-childitem": { switches: ["-force", "-name", "-file", "-directory", "-hidden"], path: true },
  "get-item": { switches: ["-force"], path: true, requiredPath: true },
  "get-content": { switches: ["-raw"], values: { "-totalcount": "integer", "-tail": "integer" }, path: true, requiredPath: true },
  "test-path": { switches: [], path: true, requiredPath: true },
};

function localShellPath(value) {
  return /^[a-zA-Z0-9_. /\\-]+$/.test(value) && !value.startsWith("-")
    && !/^[\\/]/.test(value) && !value.split(/[\\/]/).includes("..");
}

function readOnlyPowerShell(args, trustedContext) {
  if (trustedContext.shellExecution?.freshProcess !== true || trustedContext.shellExecution?.noProfile !== true) return false;
  if (!fields(args, ["command", "description", "workdir", "timeoutMs", "run_in_background"], ["command"])
    || !strings(args, ["command", "description", "workdir"])
    || (args.timeoutMs !== undefined && !integerIn(args.timeoutMs, 1))
    || (args.run_in_background !== undefined && args.run_in_background !== false)
    || (args.workdir !== undefined && !localShellPath(args.workdir))) return false;
  const command = args.command;
  if (!command || /[^a-zA-Z0-9_ .\\/'"\t-]/.test(command)) return false;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^ \t'"]+/g) ?? [];
  if (tokens.join(" ") !== command.trim().replace(/[ \t]+/g, " ")) return false;
  const commandName = tokens[0]?.toLowerCase();
  if (!Object.hasOwn(POWERSHELL_READ_CONTRACTS, commandName)) return false;
  const contract = POWERSHELL_READ_CONTRACTS[commandName];
  const seen = new Set();
  let hasPath = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const parameter = token.toLowerCase();
    if (token.startsWith("-")) {
      if (seen.has(parameter)) return false;
      seen.add(parameter);
      if (contract.switches.includes(parameter)) continue;
      const valueKind = parameter === "-literalpath" && contract.path ? "path" : contract.values?.[parameter];
      if (!valueKind || index + 1 >= tokens.length) return false;
      const rawValue = tokens[++index];
      const value = /^['"]/.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
      if (valueKind === "path") {
        if (hasPath || !localShellPath(value)) return false;
        hasPath = true;
      } else if (valueKind === "integer") {
        if (!/^\d+$/.test(value) || !integerIn(Number(value), 0)) return false;
      } else if (!/^[a-zA-Z0-9_.-]+$/.test(value)) return false;
    } else {
      const value = /^['"]/.test(token) ? token.slice(1, -1) : token;
      if (!contract.path || hasPath || !localShellPath(value)) return false;
      hasPath = true;
    }
  }
  return !contract.requiredPath || hasPath;
}

function userQuestions(args) {
  return fields(args, ["questions"], ["questions"]) && Array.isArray(args.questions) && args.questions.length > 0
    && args.questions.every((question) => fields(question, ["id", "question", "header", "options", "multi_select"], ["id", "question"])
      && nonemptyString(question.id) && nonemptyString(question.question) && strings(question, ["header"])
      && (question.multi_select === undefined || typeof question.multi_select === "boolean")
      && (question.options === undefined || (Array.isArray(question.options) && question.options.every((option) =>
        fields(option, ["label", "description"], ["label"]) && nonemptyString(option.label) && strings(option, ["description"])))));
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
  // `job_output` 是只读查询：它只读取指定后台任务已经产生的输出，不写文件、
  // 不改任务状态。缺了这条契约，它就会落进末尾的 unknown 分支并把 highImpact
  // 设成 true，于是一次纯读取也要先过模型复核（用户实际感受到的「读一下任务
  // 输出都被拦」）。
  //
  // 只在参数形状**严格**匹配（`job_id` 字符串、`wait` 布尔、`timeout_ms` 有限数）
  // 时才下这个结论：多出任何未知字段，就可能是在借这个工具做别的事（往参数里
  // 夹带别名或其他动作），那时必须退回 unknown 交给模型复核，不能凭工具名放行。
  if (toolName === "job_output" && fields(args, ["job_id", "wait", "timeout_ms"], ["job_id"])
    && typeof args.job_id === "string"
    && (args.wait === undefined || typeof args.wait === "boolean")
    && (args.timeout_ms === undefined || Number.isFinite(args.timeout_ms))) {
    return known("read_local", "known-local-job-output-query", { recoverability: "no-mutation" });
  }
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
  if (["undo_list", "undo_message_list"].includes(toolName) && fields(args, [])) {
    return known("read_local", "known-undo-history-query", { recoverability: "no-mutation" });
  }
  if (toolName === "undo_diff" && fields(args, ["snapshot_id"], ["snapshot_id"]) && nonemptyString(args.snapshot_id)) {
    return known("read_local", "known-undo-diff-query", { recoverability: "no-mutation" });
  }
  if (toolName === "team_task_create" && fields(args, ["subject", "description", "blocked_by", "write_scopes"], ["subject", "description"])
    && nonemptyString(args.subject) && nonemptyString(args.description)
    && optionalStringArray(args.blocked_by) && optionalStringArray(args.write_scopes)) {
    return known("internal_state", "bounded-team-task-state", { recoverability: "host-revisioned", hostEnforced: true });
  }
  if (toolName === "wait_agent" && fields(args, ["timeout_ms"])
    && (args.timeout_ms === undefined || integerIn(args.timeout_ms, 10_000, 3_600_000))) {
    return known("internal_state", "bounded-agent-inbox-wait", { recoverability: "no-mutation", hostEnforced: true });
  }
  if (toolName === "interrupt_agent" && fields(args, ["agent"], ["agent"]) && nonemptyString(args.agent)) {
    return known("internal_state", "bounded-descendant-interruption", { recoverability: "stop-not-reversible", hostEnforced: true });
  }
  if (toolName === "job_kill" && fields(args, ["job_id", "reason"], ["job_id"]) && nonemptyString(args.job_id) && strings(args, ["reason"])) {
    return known("internal_state", "bounded-owned-job-cancellation", { recoverability: "stop-not-reversible", hostEnforced: true });
  }
  if (toolName === "ask_user_question" && userQuestions(args)) {
    return known("internal_state", "bounded-user-question", { recoverability: "question-not-retractable", hostEnforced: true });
  }
  if (toolName === "create_goal" && fields(args, ["objective", "max_goal_rounds"], ["objective"]) && nonemptyString(args.objective)
    && (args.max_goal_rounds === undefined || integerIn(args.max_goal_rounds, 1))) {
    return known("internal_state", "bounded-session-goal-state", { recoverability: "host-revisioned", hostEnforced: true });
  }
  if (toolName === "update_goal" && fields(args, ["goal_id", "revision", "action", "objective", "max_goal_rounds", "blocked_reason"], ["goal_id", "revision", "action"])
    && nonemptyString(args.goal_id) && args.goal_id === args.goal_id.trim() && integerIn(args.revision, 1)
    && ["edit", "pause", "resume", "complete", "blocked"].includes(args.action)
    && strings(args, ["objective", "blocked_reason"])
    && (args.max_goal_rounds === undefined || integerIn(args.max_goal_rounds, 0))
    && (args.action !== "blocked" || nonemptyString(args.blocked_reason))
    && (args.action !== "edit" || nonemptyString(args.objective) || args.max_goal_rounds > 0)) {
    return known("internal_state", "bounded-session-goal-state", { recoverability: "host-revisioned", hostEnforced: true });
  }
  if (toolName === "team_task_update" && fields(args, ["task_id", "expected_revision", "action", "subject", "description", "blocked_by", "write_scopes", "owner"], ["task_id", "expected_revision", "action"])
    && typeof args.task_id === "string" && Number.isSafeInteger(args.expected_revision) && args.expected_revision >= 0
    && strings(args, ["subject", "description", "owner"]) && optionalStringArray(args.blocked_by) && optionalStringArray(args.write_scopes)
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
    if (toolName === "pwsh" && readOnlyPowerShell(args, trustedContext)) {
      return known("read_local", "known-read-only-powershell-command", { recoverability: "no-mutation" });
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
