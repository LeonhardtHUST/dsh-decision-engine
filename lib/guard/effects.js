export const TOOL_EFFECT_KINDS = ["read_local", "write_workspace", "internal_message", "internal_state", "external_network", "invalid_request", "privileged", "destructive", "unknown"];

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

// ---------------------------------------------------------------------------
// 有界本地删除的豁免形状
//
// 用户的反馈是「工作区里删一个日志文件也要被一刀切拦」。但「命令里出现 rm」
// 与「这次调用真的只删工作区内一个文件」之间有很长一段距离：变量、通配符、
// 管道/分号串联、多目标、`..` 越界、`.git`、盘符根，任何一项都可能把一次
// 普通清理变成不可逆的越界破坏。所以这里只承认**能被完全静态证明**的形状：
//
//   命令名 ∈ {remove-item, rm, del, erase} 且大小写不敏感
//   恰好一个目标 token，且可以是带引号的整体
//   零开关（-Recurse / -Force / -rf / /s 一律不认）
//   目标字符集封闭：没有变量、通配、重定向、命令替换、UNC、盘符根、`..`、`.git`
//
// 命中形状只是「候选」，是否在工作区/临时目录里仍要宿主 fs 解析后的
// containment 证据（context.js 的 destructiveTargetScope）。缺任何一维都退回
// 原有的 requires_approval，不在这里做任何猜测。
// ---------------------------------------------------------------------------
const DESTRUCTIVE_SINGLE_COMMANDS = new Set(["remove-item", "rm", "del", "erase"]);
const DESTRUCTIVE_SINGLE_SHAPE = /^[ \t]*(remove-item|rm|del|erase)[ \t]+(?:'([^']*)'|"([^"]*)"|([^ \t]+))[ \t]*$/i;
const BOUNDED_DESTRUCTIVE_PATH = /^[A-Za-z0-9_.:\\/ +-]+$/;

/**
 * 判断一个删除目标是否是「单个、封闭的本地路径」。
 *
 * 字符集与分段检查都在这里完成，不读文件系统：这只回答「形状是否可证明」，
 * 真实位置由宿主 fs 解析后判定。盘符根、`.`、UNC、`..`、`.git`、通配符、
 * 变量、参数展开、splatting、`~`、drive-relative（`C:x`）一律不算。
 */
export function boundedDestructivePath(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) return false;
  if (!BOUNDED_DESTRUCTIVE_PATH.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("~")) return false;
  if (/^[\\/]{2}/.test(value)) return false;
  // 冒号只允许出现在绝对盘符前缀；PS provider（env: / variable:）和 ADS
  // 不是 fs.resolve 所证明的普通文件目标。
  if (value.includes(":") && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(":"))) return false;
  if (/^[A-Za-z]:$/.test(value) || /^[A-Za-z]:[\\/]$/.test(value) || /^[\\/]$/.test(value)) return false;
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (!segments.length) return false;
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) return false;
  if (segments.length === 1 && segments[0] === ".") return false;
  return true;
}

/**
 * 从 shell 调用里解析出「单个有界删除」候选。
 *
 * 只在参数形状严格匹配时返回候选；否则返回 undefined，调用方按原有危险
 * 命令处理。返回值不含原始路径以外的推断，也不表示目标真的在工作区内。
 */
export function boundedDestructiveTarget({ toolName, args } = {}) {
  if (!["pwsh", "bash", "shell"].includes(toolName) || !object(args) || typeof args.command !== "string") return undefined;
  const command = args.command;
  if (/[\r\n\0]/.test(command)) return undefined;
  const match = DESTRUCTIVE_SINGLE_SHAPE.exec(command);
  if (!match) return undefined;
  const commandName = match[1].toLowerCase();
  if (!DESTRUCTIVE_SINGLE_COMMANDS.has(commandName)) return undefined;
  const target = match[2] ?? match[3] ?? match[4];
  if (!boundedDestructivePath(target)) return undefined;
  // 非 PowerShell 中反斜杠可能是转义符；不能把 shell 实际目标当作原始文本。
  // 未知 shell 方言也只接受这部分各方言一致的字面路径。
  if (toolName !== "pwsh" && /[\\:]/.test(target)) return undefined;
  return { commandName, target };
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

// 宿主对 write/edit/bash/pwsh 的 sandbox_permissions 请求走严格更宽阶梯
// （dsh-sandbox/src/escalation.ts:64-67、209-219）：
//   - requested === 当前有效 mode：no-op，不触发审批；
//   - requested 严格更宽：才是真正提权，native 审批只应针对这一种；
//   - 其它值：非法枚举/类型、full→workspace-write 这类不更宽的请求，宿主会抛
//     SANDBOX_ESCALATION_INVALID_ARGUMENT，不属于可审批的权限升级。
// 另外沙箱元数据必须成对：非 no-op 请求缺说明/空说明/非字符串说明，或说明
// 单独出现，都是可证明无效的请求。只有「合法且非同级」才保留 privileged。
const PERMISSION_TOOLS = ["write", "edit", "bash", "pwsh"];
const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];
const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

function permissionRequest(toolName, args, trustedContext) {
  if (!PERMISSION_TOOLS.includes(toolName)) return undefined;
  const requested = args.sandbox_permissions;
  const justification = args.justification;
  const hasJustification = Object.hasOwn(args, "justification") && justification !== undefined;
  if (requested === undefined) {
    if (!hasJustification) return undefined;
    // 说明单独出现：fs/bash 把空说明当省略，非空说明则宿主判 invalid argument；
    // pwsh 在 approve 之前无条件校验，任何已给出的说明都不合法。
    if (toolName === "pwsh") return { kind: "invalid", field: "justification", problem: "orphan-justification" };
    if (typeof justification !== "string") return { kind: "invalid", field: "justification", problem: "invalid-type" };
    if (!nonemptyString(justification)) return undefined;
    return { kind: "invalid", field: "justification", problem: "orphan-justification" };
  }
  if (typeof requested !== "string" || !ESCALATION_TARGETS.includes(requested)) {
    return { kind: "invalid", field: "sandbox_permissions", problem: "invalid-value" };
  }
  if (hasJustification && typeof justification !== "string") {
    return { kind: "invalid", field: "justification", problem: "invalid-type" };
  }
  // pwsh 先校验说明再判断同模式：同模式也要非空句子。
  if (toolName === "pwsh" && !nonemptyString(justification)) {
    return { kind: "invalid", field: "justification", problem: "missing-justification" };
  }
  const effectiveMode = trustedContext?.sandboxMode;
  if (!SANDBOX_MODES.includes(effectiveMode)) {
    // 有效 mode 未知：既不能证明 same no-op，也不能证明请求更窄；保持提权保护，
    // 不推断降档。fs/bash 缺说明在同模式可省，因此也不能证明无效。
    return { kind: "privileged" };
  }
  if (requested === effectiveMode) return { kind: "same-mode" };
  // 显式非 same：宿主要求非空说明；full 之上没有更宽模式，ws 只是降级请求。
  if (!nonemptyString(justification)) return { kind: "invalid", field: "justification", problem: "missing-justification" };
  if (effectiveMode === "danger-full-access") return { kind: "invalid", field: "sandbox_permissions", problem: "non-widening-target" };
  return { kind: "privileged" };
}

const BOUNDED_DESTRUCTIVE_SCOPE = ["workspace", "temp"];
const DESTRUCTIVE_SANDBOX_MODES = ["workspace-write", "danger-full-access"];

/**
 * 有界删除豁免的多维证据判定。
 *
 * 四维全部成立才返回豁免对象，缺一维返回 undefined（调用方保持原有强制审批）：
 *   1. 命令形状：单命令、单目标、零开关（boundedDestructiveTarget）；
 *   2. 路径位置：宿主 fs 解析后的 containment 证据（context.destructiveTargetScope）；
 *   3. 沙箱边界：只读模式仍然要问——删除超出只读权限；
 *   4. 目标数量：解析器只接受一个目标 token，这里再断言一次。
 *
 * 返回的对象只含可枚举的稳定字段（命令名、位置、数量），不含原始路径：路径
 * 已经在 args 里，审计对 effect 只落摘要，不需要再复制一份。
 */
function boundedDestructiveExemption(toolName, args, trustedContext) {
  const candidate = boundedDestructiveTarget({ toolName, args });
  if (!candidate) return undefined;
  const targetScope = trustedContext?.destructiveTargetScope;
  if (!BOUNDED_DESTRUCTIVE_SCOPE.includes(targetScope)) return undefined;
  if (!DESTRUCTIVE_SANDBOX_MODES.includes(trustedContext?.sandboxMode)) return undefined;
  return { kind: "bounded-local-destructive", commandName: candidate.commandName, targetScope, targetCount: 1 };
}

export function classifyToolEffect({ toolName, args: originalArgs, trustedContext = {}, scope } = {}) {
  let args = originalArgs;
  const effect = {
    kind: "unknown", known: false, highImpact: true, hostEnforced: "unknown",
    scope: scope?.kind ?? "unknown", canonical: "unknown", recoverability: "unknown",
    reasonCodes: ["unknown-tool-effect"], evidence: [],
  };
  const known = (kind, reason, extra = {}) => ({ ...effect, kind, known: true, highImpact: false, reasonCodes: [reason], evidence: [{ source: "strict-local-tool-contract", toolName }], ...extra });
  if (!object(args)) return { ...effect, reasonCodes: ["invalid-tool-arguments"] };
  const permission = permissionRequest(toolName, args, trustedContext);
  if (permission?.kind === "invalid") {
    // 固定的机器原因码 + 不含原始参数值的证据：无效请求本地拒绝，不冒充
    // 「需要审批」，也不把调用方的任意输入回显给用户。
    return {
      ...effect, kind: "invalid_request", known: true, highImpact: true,
      reasonCodes: ["invalid-sandbox-permission-request"],
      evidence: [{ source: "host-escalation-contract", toolName, field: permission.field, problem: permission.problem }],
    };
  }
  if (permission?.kind === "same-mode") {
    const { sandbox_permissions: _permission, justification: _justification, ...rest } = args;
    args = rest;
  }
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
    if (/(?:^|[\s;&|])(?:rm|rmdir|del|erase|Remove-Item|Clear-Content|Format-Volume|diskpart|shred)(?:\s|$)|git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i.test(command)) {
      const exemption = boundedDestructiveExemption(toolName, args, trustedContext);
      if (!exemption) return known("destructive", "possible-shell-destructive-effect", { highImpact: true });
      // 形状与宿主证据都成立时才出这条：kind 仍是 destructive（别处统计不能把
      // 它当成只读），但 policy 会据此把一刀切 mandatory 降成「交宿主沙箱」。
      return {
        ...effect, kind: "destructive", known: true, highImpact: true,
        reasonCodes: ["possible-shell-destructive-effect", "bounded-local-destructive-exempt"],
        evidence: [
          { source: "strict-local-tool-contract", toolName },
          { source: "strict-local-tool-contract", field: "destructiveCommand", value: exemption.commandName, toolName },
          { source: "strict-local-tool-contract", field: "destructiveTargetCount", value: 1, toolName },
          { source: "fs.resolve+contains", field: "destructiveTargetScope", value: exemption.targetScope, temporalScope: "pre-execution-snapshot" },
          { source: "host-sandbox-policy", field: "sandboxMode", value: trustedContext.sandboxMode },
        ],
        exemption,
      };
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
