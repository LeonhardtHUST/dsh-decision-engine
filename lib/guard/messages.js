const MESSAGES = {
  "host-tool-access-denied": ["宿主未授权此工具，已阻止调用", "The host has not authorized this tool"],
  "recipient-authority-unverified": ["目标不是本机可持续接续的子代理，发消息需要你确认", "The recipient is not a resumable child on this host; sending requires your approval"],
  "high-impact-requires-explicit-approval": ["此操作涉及提权或破坏性变更，需要用户明确批准", "Privilege escalation or destructive changes require explicit approval"],
  "privilege-change-requires-approval": ["操作可能提升权限或修改访问控制，需要在宿主原生审批卡中批准本次调用", "This operation may elevate privileges or change access controls; approve this call through the host's native approval prompt"],
  "destructive-operation-requires-approval": ["命令可能执行删除、清空或重置操作，需要在宿主原生审批卡中批准本次调用", "The command may delete, clear or reset data; approve this call through the host's native approval prompt"],
  "approval-policy-never": ["此操作需要原生审批，但当前会话的审批策略为 never，已阻止调用。停止重复调用；聊天中的同意不会生成本次工具授权。请用户自行将宿主审批策略切换为 ask，并确认审批通道可用后，再发起新调用。不要更换命令绕过限制。", "This operation requires native approval, but this session's approval policy is never. The call was blocked. Stop retrying: consent in chat does not grant approval for this tool call. Ask the user to change the host approval policy to ask and confirm that the approval channel is available before starting a new call. Do not change commands to bypass the restriction."],
  "approval-channel-unavailable": ["此操作需要原生审批，但当前无法确认可用的宿主审批通道，已阻止调用。停止重复调用；聊天中的同意不能替代本次原生审批。请用户检查并恢复宿主审批服务与权限上下文后，再发起新调用。不要更换命令绕过限制。", "This operation requires native approval, but an available host approval channel could not be verified. The call was blocked. Stop retrying: consent in chat cannot replace native approval for this call. Ask the user to restore the host approval service and permission context before starting a new call. Do not change commands to bypass the restriction."],
  "write-exceeds-read-only-permission": ["当前为只读权限，写入需要用户明确批准", "Writing exceeds the current read-only permission"],
  "write-outside-authorized-workspace": ["写入目标超出已授权工作区，需要用户明确批准", "Writing outside the authorized workspace requires explicit approval"],
  "verified-local-operation-defer-to-host": ["本地规则检查通过，未调用模型；仍需遵守宿主权限", "Local checks passed without a model call; host permissions still apply"],
  "safe-local-operation-host-sandbox": ["本地规则已判定工作区内安全操作，交宿主沙箱执行", "Local checks found a safe in-workspace operation; the host sandbox still applies"],
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
  "fallback-review-failed": ["回退大模型请求失败、超时或回答无效，已安全阻止调用", "Fallback review failed, timed out or returned an invalid answer; the call was denied"],
  "mandatory-policy-protected": ["此调用受到明确权限约束，回退策略不能代替用户批准", "Fallback review cannot replace approval required by an explicit permission constraint"],
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
  const approvalBlocked = action.kind === "deny" && ["approval-policy-never", "approval-channel-unavailable"].includes(code);
  return { ...action, reason: approvalBlocked ? `${message[0]}\n${message[1]}` : message[0], reasonCode: code, ...(action.kind === "ask" ? { displayReason: { zh: message[0], en: message[1] } } : {}) };
}
