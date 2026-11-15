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

## 1.9.1 实录复查与后续修正（未发布）

按用户指定的北京时间 2026-11-15 00:30 起读取当前日志及 `.1` 轮转备份。首次完整提取快照有 182 条时间范围内记录，其中 39 条拒绝，JSON 均可解析。真实日志仅留在 Git 忽略目录，不提交会话标识、用户正文或工具参数。

- 26 条 `unresolved-effect-needs-model-review`：primary 已运行，但非 Auto 分支把 unknown 无条件覆盖为 ask/deny，连 tolerance=delegate 也被拒绝。
- 12 条 `advisory-failed-unknown-effect`：工作区 edit 已知 safe、四个核心信号有值，但 primary 解析失效；历史未记录具体 validation errors，不能反推原始错误分布。旧解析器确实会因附加 confidence/probabilities 校验失败使整体失效。
- 1 条 `fallback-model-deny`：唯一一条实际调用独立回退模型后拒绝的记录，不能和其余 38 条混淆。
- 5 条 MCP 拒绝中，4 条的 primary 与 tolerance 均已有有效 delegate，最终仍被 unknown 分支覆盖；另 1 条 primary 解析失败。5 条全部未请求 fallback。

修正非 Auto 分支：有效 primary 与所选 tolerance 不再被 unknown 无条件覆盖；只有最终确实 ask 且 approval=never 才拒绝。Auto 不确定性仍独立复核，真实硬约束保持不变。

附加概率和 confidence 元数据校验失败时只保留 warning 并弃用该元数据，不归一化、不用它抬高 severity，也不使有效必需信号整体失效；risk choice 或必需 noul 无效仍失败关闭。新审计记录 validationErrors、metadataWarnings、raw_class_probabilities，避免再只剩 answer-shape-mismatch。

服务解析依据宿主源码：先用 agentPresets.serviceFor 读取确实存在的隔离 preset 实例；正常未覆盖时使用 actor.ctx 的共享基础服务。实例存在但方法返回 undefined 不再重试更宽全局实例；解析抛错保持不可用。回退 LLM 同样按 actor 解析。日志新增 permissionPreset、approvalPolicy、automatic 和 serviceSources。历史 39 条没有 permissionPreset，不能断言它们全因 Auto 识别错误造成。

60 项匿名实录形状回归及包含作用域的 231 项组合回归通过；不是对原请求副作用的重放。真实主端点探测在配置前置检查退出，没有发请求，没有更改用户配置；运行中的已发布 1.9.1 不会自动获得这些源码修正。

## 验证边界

125 项专项回归、212 项组合回归通过；24 个独立合成情景的四档矩阵通过。组合之间有重叠，不相加成独立样本数。模型 stub 的 allow/deny/failure 仅验证路由不变量，不代表真实危险 FNR 或概率校准。

本次按 hunk 集成决策历史状态展示，不覆盖其他任务的 dark-mode UI 改动；其他任务是否已提交以 Git 记录为准。发布仍需干净提交的 Linux 完整 CI 成功；已安装的 1.9.0 不会因源码修改自动升级。
