const MESSAGES = {
  "host-tool-access-denied": ["宿主未授权此工具，已阻止调用", "The host has not authorized this tool"],
  // 可证明无效的沙箱权限请求：固定文案，不引用调用方给的枚举值或假设
  // justification，也不建议切换审批策略——宿主在审批之前就会拒绝这种请求。
  "invalid-sandbox-permission-request": ["权限请求参数无效；本次未发起审批或授予权限。请按当前有效沙箱与工具参数契约修正，不要切换审批策略绕过", "The permission request is malformed; no approval was requested and no permission was granted. Correct it against the effective sandbox and tool argument contract; do not switch the approval policy to bypass it"],
  "recipient-authority-unverified": ["目标不是本机可持续接续的子代理，发消息需要你确认", "The recipient is not a resumable child on this host; sending requires your approval"],
  "high-impact-requires-explicit-approval": ["此操作涉及提权或破坏性变更，需要用户明确批准", "Privilege escalation or destructive changes require explicit approval"],
  "privilege-change-requires-approval": ["操作可能提升权限或修改访问控制，需要在宿主原生审批卡中批准本次调用", "This operation may elevate privileges or change access controls; approve this call through the host's native approval prompt"],
  "destructive-operation-requires-approval": ["命令可能执行删除、清空或重置操作，需要在宿主原生审批卡中批准本次调用", "The command may delete, clear or reset data; approve this call through the host's native approval prompt"],
  "approval-policy-never": ["此操作需要原生审批（本插件的审查规则要求），但当前会话的审批策略为 never，已阻止调用。停止重复调用；聊天中的同意不会生成本次工具授权。请用户自行将宿主审批策略切换为 ask，并确认审批通道可用后，再发起新调用。不要更换命令绕过限制。", "This operation requires native approval under this plugin's review rules, but this session's approval policy is never. The call was blocked. Stop retrying: consent in chat does not grant approval for this tool call. Ask the user to change the host approval policy to ask and confirm that the approval channel is available before starting a new call. Do not change commands to bypass the restriction."],
  "approval-channel-unavailable": ["此操作需要原生审批（本插件的审查规则要求），但当前无法确认可用的宿主审批通道，已阻止调用。停止重复调用；聊天中的同意不能替代本次原生审批。请用户检查并恢复宿主审批服务与权限上下文后，再发起新调用。不要更换命令绕过限制。", "This operation requires native approval under this plugin's review rules, but an available host approval channel could not be verified. The call was blocked. Stop retrying: consent in chat cannot replace native approval for this call. Ask the user to restore the host approval service and permission context before starting a new call. Do not change commands to bypass the restriction."],
  "write-exceeds-read-only-permission": ["当前为只读权限，写入需要用户明确批准", "Writing exceeds the current read-only permission"],
  "write-outside-authorized-workspace": ["写入目标超出已授权工作区，需要用户明确批准", "Writing outside the authorized workspace requires explicit approval"],
  "verified-local-operation-defer-to-host": ["本地规则检查通过，未调用模型；仍需遵守宿主权限", "Local checks passed without a model call; host permissions still apply"],
  "safe-local-operation-host-sandbox": ["本地规则已判定工作区内安全操作，交宿主沙箱执行", "Local checks found a safe in-workspace operation; the host sandbox still applies"],
  "bounded-local-destructive-defer-to-host": ["工作区/临时目录内的单个文件删除已通过路径、命令形状与宿主证据检查，交宿主沙箱执行", "A single-target deletion inside the workspace or temp directory passed path, command-shape and host evidence checks; the host sandbox still applies"],
  "outside-workspace-defer-to-host": ["目标在插件工作区外，交宿主沙箱与权限策略决定", "The target is outside the plugin workspace; the host sandbox and permission policy decide"],
  "tolerance-delegate": ["安全档位放行此次调用（仅软审查范围）", "The safety level allowed this call within soft review"],
  "tolerance-deny": ["安全档位在无审批通道时阻止了此次调用", "The safety level denied this call because no approval channel exists"],
  "model-material-risk": ["决策模型提示可能有风险，需要进一步审查", "The decision model flagged potential risk for further review"],
  "model-injection-suspect": ["决策模型发现疑似提示注入，需要进一步审查", "The decision model flagged suspected prompt injection"],
  "model-irreversible-unrelated": ["调用可能不可恢复或偏离任务，需要进一步审查", "Potential irreversible or unrelated effects need further review"],
  "model-low-risk-advisory": ["决策模型评估为低风险，已交由宿主执行权限检查", "The decision model assessed low risk; host permissions still apply"],
  "unresolved-effect-needs-model-review": ["无法静态判断工具副作用，需模型复核，不代表需要权限升级", "The tool effect needs model review; uncertainty is not a permission escalation"],
  "fallback-model-allow": ["回退大模型已复核并允许此次调用，宿主权限约束仍然生效", "The fallback model allowed this call; host permissions still apply"],
  "fallback-model-deny": ["回退大模型已复核并拒绝此次调用", "The fallback model denied this call"],
  "fallback-allow-soft-review-only": ["已按回退策略放行软审查，未授予额外宿主权限", "The fallback policy allowed soft review without granting additional host permissions"],
  "fallback-deny": ["已按回退策略阻止此次调用", "The fallback policy denied this call"],
  "fallback-model-unavailable": ["回退模型未配置或宿主模型服务不可用，已安全阻止调用", "The fallback route or host model service is unavailable; the call was denied"],
  // 回退路由/思考档位在发请求前就不兼容：只描述事实和修正方向，不暗示已自动
  // 换模型或换档位（那会改变用户配置的审查路由）。
  "fallback-model-incompatible": ["回退模型不支持所配置的思考档位，请在设置中选择该模型实际支持的档位；未自动更换模型或档位。", "The fallback model does not support the configured reasoning effort. Choose an effort that model actually supports in settings; the model and effort were not changed automatically."],
  "fallback-review-failed": ["回退大模型请求失败、超时或回答无效，已安全阻止调用", "Fallback review failed, timed out or returned an invalid answer; the call was denied"],
  "mandatory-policy-protected": ["此调用受到明确权限约束，回退策略不能代替用户批准", "Fallback review cannot replace approval required by an explicit permission constraint"],
  // 本地规则已判安全、且宿主有原生审批通道时，回退模型的「拒绝」只是软审查
  // 摩擦，不是权限约束：结论交回宿主原生审批卡，而不是由插件的第二个模型替
  // 用户说不。文案只描述这次询问的来源，不复述模型理由（理由进 humanReason）。
  "safe-soft-review-ask": ["回退模型建议拒绝此次安全操作，交宿主原生审批决定", "The fallback review suggested denying this safe operation; the host native approval decides"],
  "advisory-unavailable": ["决策模型未能给出有效结果，需要进一步审查", "The decision model did not return a valid result"],
  "advisory-failed-unknown-effect": ["模型审查失败，无法确认此工具的副作用", "Model review failed and the tool's effects remain unresolved"],
  "guard-exception": ["审查链发生内部错误，未将错误视为授权", "The review pipeline failed; an error does not grant authorization"],
  "review-cancelled": ["审查已取消", "Review was cancelled"],
  // 安全档位（tolerance）把「默认放行」升级成「询问」时的固定文案。
  //
  // 为什么需要一条独立词条而不是复用上面任何一条：那些描述的是**模型发现了
  // 什么**（注入嫌疑、材料风险……），而这一条描述的是**用户选的档位要求问**。
  // 借用前者会让审计记录说谎——一次模型判定低风险的调用，标题却写着「模型
  // 提示可能有风险」。文案里刻意不出现档位 note 里的 `severity=` / 阈值小数：
  // 审批卡标题是给人读的一行话，不是遥测字段。
  "tolerance-ask": ["安全档位要求确认此次调用", "The safety level asks for confirmation"],
};

/**
 * `unclassified` 的展示文案与词条表**分开**。
 *
 * 它不是一个可命名的裁决原因，而是「reason 不在词条表里」的兜底结果。
 * 如果把它也放进 `MESSAGES`，`guardOutcomeMessage` 的 explicit 判断会把
 * 已经归一化的 `unclassified` 当成权威码原样返回，文案与本地化都会被跳过
 * （2026-11-16 审计 P0-1 的现场）。
 */
const UNCLASSIFIED_MESSAGE = ["未分类的裁决原因，详见审计明细", "Unclassified decision reason; see the audit detail"];

/**
 * 给「安全档位把默认放行升级成询问」的裁决挂上固定双语标题。
 *
 * 为什么不能只靠 `MESSAGES` 按 `reason` 查表：这条 ask 的 `reason` 是档位
 * note（`tolerance=relaxed（严重度 0.350 ≥ 0.600…）`），属于审计/遥测口径，
 * 含字段名与裸小数，不能拿去当标题；但它又必须**逐字保留**，否则事后核对
 * 无法解释「这次为什么问」。于是两条通道分开：
 *   - `reason` 保持档位 note（审计与遥测原文）；
 *   - `displayReason` 用本条固定文案（宿主审批卡只渲染它）。
 *
 * @param action - 当前 ask 裁决（`{kind:'ask', reason:<档位 note>}`）。
 * @returns 附带 `reasonCode: 'tolerance-ask'` 与 `displayReason` 的副本。
 */
export function toleranceAskAction(action) {
  const [zh, en] = MESSAGES["tolerance-ask"];
  // `humanReason` 保留档位 note（含 severity / 阈值），`reasonCode` 只给稳定
  // 枚举值。审计聚合按 reasonCode，人读按 humanReason——两者不能互换。
  return { ...action, reasonCode: "tolerance-ask", displayReason: { zh, en }, humanReason: action.reason };
}

/**
 * 把「回退模型对本地已判安全调用给出的 deny」改写成一次宿主原生询问。
 *
 * 为什么不是放行：`safe` 只说明本地静态规则确认了工作区边界内的可逆操作，
 * 回退模型的拒绝仍然是有效证据，只是它不该由插件的第二个模型替用户做最终
 * 裁决——宿主有原生审批卡时，把判断交给用户才是正确收尾（`ask` 在宿主侧
 * 同样可能被拒绝，所以并没有放宽任何权限）。
 *
 * 为什么必须保留原文：回退与模型的口径（`fallback-model-deny`、
 * `fallback=session`、`model-material-risk`）是审核与遥测要能复盘的证据，
 * 所以它们逐字进 `humanReason`；`reason` 只留固定双语标题，`reasonCode`
 * 只留稳定枚举 `safe-soft-review-ask`（机器聚合按它）。
 *
 * @param action - 当前 deny 裁决（来自回退复核）。
 * @param fallback - 回退复核结果（`reason` / `fallback` 字段）。
 * @param baseAction - 主模型原始意见，用于把「模型为什么问」一并留在审计里。
 * @returns `{kind:'ask'}` 副本，带固定双语标题与可追溯的 `humanReason`。
 */
export function safeSoftReviewAskAction(action, fallback, baseAction) {
  const [zh, en] = MESSAGES["safe-soft-review-ask"];
  const policy = fallback?.fallback ?? "unknown";
  const review = fallback?.reason ?? "unknown";
  const model = baseAction?.reason ?? "unknown";
  return {
    ...action,
    kind: "ask",
    reasonCode: "safe-soft-review-ask",
    reason: zh,
    displayReason: { zh, en },
    humanReason: `回退模型建议拒绝此次安全操作（review=${review}，fallback=${policy}）；主模型意见=${model}；本地规则判定为工作区内可逆操作，交宿主原生审批决定`,
  };
}

/**
 * 「这次拦截到底触发了哪条强制约束」——只认下表里的稳定原因码。
 *
 * `approval-policy-never` / `approval-channel-unavailable` 只回答「为什么没走
 * 原生审批」，不回答「为什么该拦」。代理和用户真正需要的是后者：删除、越权
 * 写、只读写、接收方权限……这些原因来自 `policy.js` 的固定枚举
 * （`mandatory.reasonCodes`），不是模型或调用方给的自由文本。
 *
 * 所以提示只展示映射里的一句话；词表之外的原因码一律走兜底文案，绝不把未知
 * 字符串原样回显——那等于把不可信内容当文案拼给用户看。
 */
const APPROVAL_TRIGGER_MESSAGES = {
  "recipient-authority-unverified": ["消息接收方的权限无法核实", "the recipient's authority could not be verified"],
  "privilege-change-requires-approval": ["可能提升权限或修改访问控制", "possible privilege escalation or access-control changes"],
  "destructive-operation-requires-approval": ["可能删除、清空或重置数据", "possible deletion, clearing or resetting of data"],
  "write-exceeds-read-only-permission": ["当前会话为只读权限，写入超出该权限", "the session is read-only and the write exceeds that permission"],
  "write-outside-authorized-workspace": ["写入目标在已授权工作区之外", "the write target is outside the authorized workspace"],
  "mandatory-policy-protected": ["受显式权限约束保护", "protected by an explicit permission constraint"],
};

const APPROVAL_TRIGGER_FALLBACK = ["具体约束未能归类为已知规则，详见审计明细", "the specific constraint could not be classified; see the audit detail"];

/**
 * 给「原生审批被策略/通道拦下」的拒绝补一行实际触发原因。
 *
 * 优先级：`action.policyBlockReason`（`mandatoryApprovalDecision` 已经挑好的
 * 原始约束）→ `mandatory.reasonCodes[0]`（旧调用方没有该字段时的兜底）。
 * 只展示词表内的原因码；未登记的原因码只出兜底话术，不拼原文。
 */
function approvalTriggerLines(action, mandatory) {
  const declared = typeof action?.policyBlockReason === "string" && action.policyBlockReason ? action.policyBlockReason : undefined;
  const codes = Array.isArray(mandatory?.reasonCodes) ? mandatory.reasonCodes : [];
  const code = declared ?? codes.find((value) => typeof value === "string" && value);
  const mapped = code !== undefined && Object.hasOwn(APPROVAL_TRIGGER_MESSAGES, code) ? APPROVAL_TRIGGER_MESSAGES[code] : undefined;
  if (!mapped) return { zh: `实际触发原因：${APPROVAL_TRIGGER_FALLBACK[0]}`, en: `Actual trigger: ${APPROVAL_TRIGGER_FALLBACK[1]}` };
  return { zh: `实际触发原因：${mapped[0]}（规则码：${code}）`, en: `Actual trigger: ${mapped[1]} (rule code: ${code})` };
}

/**
 * 原生审批结束后的模型可见拒绝原因。
 *
 * 为什么不能继续用一句「需要本次用户批准」：用户拒绝、用户取消、审批通道
 * 没给结果、根本没有批准记录，四种情况下模型该做的下一步完全不同——换方案、
 * 先问用户、让用户修审批通道、直接停止重试。混成一句会让模型把同一次调用
 * 反复重发，再弹一遍审批卡。
 *
 * 文案只说明「为什么没批准」和下一步，不复述审查依据；判定口径不动：仍然
 * 只有同一次调用、审查之后产生的 `allowed-once` 才放行。这里只新增稳定字段
 * `approvalOutcome`，`DECISION_ENGINE_MANDATORY_DENY` 错误码保持不变。
 */
const APPROVAL_DENIED_MESSAGES = {
  rejected: ["用户在原生审批中拒绝了本次调用，未获授权；不要重试同一调用，先询问用户或改用其他方案", "The user rejected this call in the native approval prompt; it is not authorized. Do not retry the same call; ask the user or choose another approach"],
  cancelled: ["本次调用的原生审批被取消，没有批准记录，未获授权；不要重试同一调用，先确认用户意图", "The native approval for this call was cancelled with no approval recorded; it is not authorized. Do not retry the same call; confirm the user's intent"],
  unavailable: ["原生审批未返回结果（审批通道不可用），本次调用未获授权；不要重试同一调用，先让用户检查审批通道", "Native approval returned no result (the approval channel is unavailable); this call is not authorized. Do not retry the same call; ask the user to check the approval channel"],
  unknown: ["本次调用没有用户批准记录（未发起审批、结果未知，或审查已拒绝），未获授权；模型或回退策略不能覆盖该约束", "No user approval is recorded for this call (not requested, outcome unknown, or denied by review); it is not authorized. Model or fallback verdicts cannot override this constraint"],
};

/** 归一的四档审批结局；未登记的值一律落到 `unknown`。 */
export const APPROVAL_DENIED_OUTCOMES = Object.keys(APPROVAL_DENIED_MESSAGES);

/**
 * 把宿主审批结局映射成固定的模型可见原因。
 *
 * @param outcome - `approvalOutcomeForCall` 的返回值，可能是 `unknown`。
 * @returns `{ outcome, reason, displayReason }`；`outcome` 只取四档之一，
 *   调用方可以依赖它做稳定分类，不必解析文案。
 */
export function approvalDeniedMessage(outcome) {
  const key = Object.hasOwn(APPROVAL_DENIED_MESSAGES, outcome) ? outcome : "unknown";
  const [zh, en] = APPROVAL_DENIED_MESSAGES[key];
  return { outcome: key, reason: zh, displayReason: { zh, en } };
}

export function guardOutcomeMessage(action, mandatory) {
  // 已显式带 `reasonCode` 的裁决（tolerance 触发的 ask / delegate / deny）：
  // `reasonCode` 是权威口径，`reason` 是调用方给的审计原文，这里只补/保留
  // `displayReason`。若走下面的通用分支，`reason` 会被文案表覆盖（档位 note
  // 丢失），`displayReason` 又会被填成与 `reason` 逐字相同的旧口径。
  const explicit = action.reasonCode !== undefined && Object.hasOwn(MESSAGES, action.reasonCode) ? MESSAGES[action.reasonCode] : undefined;
  if (explicit) {
    return { ...action, ...(action.kind === "ask" ? { displayReason: action.displayReason ?? { zh: explicit[0], en: explicit[1] } } : {}) };
  }
  const code = action.reason ?? mandatory?.reasonCodes?.[0] ?? action.kind;
  const message = MESSAGES[code];
  if (!message) {
    // 兜底：`reason` 不是已知枚举（例如档位 note、模型文案）。绝不能把它
    // 直接当 reasonCode——那会把 61 种中文长句灌进机器聚合字段，英文界面
    // 也会显示中文。稳定值统一为 `unclassified`，原文进 humanReason。
    return { ...action, reasonCode: "unclassified", humanReason: action.humanReason ?? code, ...(action.kind === "ask" ? { displayReason: { zh: UNCLASSIFIED_MESSAGE[0], en: UNCLASSIFIED_MESSAGE[1] } } : {}) };
  }
  // 这两条拒绝的 reasonCode 只说明「没走审批」，所以额外把实际触发的强制
  // 约束用固定双语补在各自语言段落后面。`reasonCode` 与机器错误码（listener
  // 的 DECISION_ENGINE_APPROVAL_*）保持原值，只影响人读文案。
  const approvalBlocked = action.kind === "deny" && ["approval-policy-never", "approval-channel-unavailable"].includes(code);
  const trigger = approvalBlocked ? approvalTriggerLines(action, mandatory) : undefined;
  return {
    ...action,
    reason: approvalBlocked ? [message[0], trigger.zh, message[1], trigger.en].join("\n") : message[0],
    reasonCode: code,
    ...(action.kind === "ask" ? { displayReason: { zh: message[0], en: message[1] } } : {}),
  };
}
