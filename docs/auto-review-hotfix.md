# 1.9.1 自动审查热修复

## 根因

1.9.0 把“不认识工具 / 无法静态解析 shell、MCP 或网络效果”直接升级为 `requires_approval`。监听器在调用决策模型之前就返回 ask/deny，Auto 没有机会使用大模型回退。

这些提前返回的记录缺少 provider/model，latency 为 0，state/questions 尚未构建，因而只显示 `unknown-high-impact-effect-requires-approval` 和空分数。它们不是模型瞬间完成的结论。

## 修复

- 不确定效果为 `unknown`，不是宿主要求真人审批的证据。Auto 先调用决策模型；不确定效果即使初判 low，也进入独立 LLM 或用户显式选择的回退策略。
- medium/high、异常和无效模型结果同样进入回退，不直接交给用户。默认模型回退失败、超时或无效输出拒绝；显式 allow/deny 仅调整软审查。
- 手动模式可询问；审批禁用时不能伪造用户批准。
- 显式 `sandbox_permissions`、宿主拒绝、已知越界写入、只读环境写入、已识别提权/破坏等硬约束仍先于模型。LLM allow 不写成宿主 allowed-once。
- 多目标补丁优先保留确定越界；另一条无法解析的路径不能掩盖它。
- `skill`、Inspect、模型目录等严格只读查询不再自锁。

## 审计与 UI

新增 `decisionSource` 与 `modelEvaluation.primary/fallback`，分开记录未请求、完成、失败、缓存命中及实际 provider/model/latency。

- 本地规则显示“本地权限规则 / 未调用模型 / 未调用”，不再展示成未知提供方的 0ms 模型推理。
- 模型失败与缓存命中使用明确标签；回退模型身份与原 primary 身份分开保留。
- 早期规则仍构建真实 state/questions 摘要，未请求时 questions.status 为 not_requested。
- 没有模型事实的规则路径不伪造模型费用记录。
- 用户提示为可读说明，机器码留在 reasonCode / denial info。
- 旧记录证据不足时保持原样，不把 0ms 倒推为特定调用状态。

## 验证边界

125 项专项回归、212 项组合回归通过；24 个独立合成情景的四档矩阵通过。组合之间有重叠，不相加成独立样本数。模型 stub 的 allow/deny/failure 仅验证路由不变量，不代表真实危险 FNR 或概率校准。

本次按 hunk 集成决策历史状态展示，不覆盖其他任务的 dark-mode UI 改动；其他任务是否已提交以 Git 记录为准。发布仍需干净提交的 Linux 完整 CI 成功；已安装的 1.9.0 不会因源码修改自动升级。
