const MESSAGES = {
  "host-tool-access-denied": ["宿主未授权此工具，已阻止调用", "The host has not authorized this tool"],
  "recipient-authority-unverified": ["无法核验接收方权限，需要用户确认", "The recipient's authority could not be verified"],
  "high-impact-requires-explicit-approval": ["此操作涉及提权或破坏性变更，需要用户明确批准", "Privilege escalation or destructive changes require explicit approval"],
  "write-exceeds-read-only-permission": ["当前为只读权限，写入需要用户明确批准", "Writing exceeds the current read-only permission"],
  "write-outside-authorized-workspace": ["写入目标超出已授权工作区，需要用户明确批准", "Writing outside the authorized workspace requires explicit approval"],
  "verified-local-operation-defer-to-host": ["本地规则检查通过，未调用模型；仍需遵守宿主权限", "Local checks passed without a model call; host permissions still apply"],
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
};

export function guardOutcomeMessage(action, mandatory) {
  const code = action.reason ?? mandatory?.reasonCodes?.[0] ?? action.kind;
  const message = MESSAGES[code];
  if (!message) return { ...action, reasonCode: code };
  return { ...action, reason: message[0], reasonCode: code, ...(action.kind === "ask" ? { displayReason: { zh: message[0], en: message[1] } } : {}) };
}
