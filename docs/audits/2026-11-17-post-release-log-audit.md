# 2026-11-17 发布后日志审计与问题登记：1.16.3 完整窗口、1.16.4 发布状态

> 本次交付：发布后问题的登记与文档补齐，不是 8 个问题已修复。
>
> 性质：只读日志复核与问题登记。本文不改代码、不改配置，也不表示下列问题已经修复。
>
> 数据：`$DSH_HOME/dsh-decision-engine/logs/2026-11-17.log` 及当日轮转文件，配合同目录的 `telemetry.jsonl`。按 session 与 call 去重 pre/result，优先保留带 `effectOutcome` 的最后记录。报告只保留脱敏计数、UTC 时间和只读扫描行号。
>
> 快照：telemetry 截止 `2026-11-17T11:47:17.406Z`（北京时间 19:47:17）；捕获日志截止 `2026-11-17T11:47:38.057Z`。两者相差 21 秒，分开统计，不混算。
>
> 版本：npm `1.16.3` 发布 `2026-11-17T03:38:45.542Z`，`1.16.4` 发布 `2026-11-17T08:56:33.413Z`，`latest` 为 `1.16.4`。本机安装仍是 `1.16.3`，本轮没有安装或重启授权。
>
> 行号：按只读扫描顺序编号，不是文件字节偏移。不复制原始 JSONL。

## 0. 结论

1.16.3 从发布到本次快照共 4 876 次去重调用，其中 defer 4 868、实际 deny 6、实际 ask 2。相对 11:25Z 基线（4 161 次）新增 715 次调用，全部是 `defer_to_host`；新增实际 deny 和 ask 都是 0。原始增量键有 716 个，其中 1 个是基线 `wait_agent` 的迟到 result（基线 pre 行 62284，新 result 行 62410），不能算成新调用。

1.16.2 旧进程保持 932 次调用，没有增量。1.16.4 在日志里仍是 0 次。fallback 累计 55 次、失败 31 次，本次新增 5 次失败，全部是 `UNSUPPORTED_REASONING_EFFORT`。捕获日志新增 748 行，全部属于 1.16.3；28 个 candidate deny 都在观察模式，没有对应的实际 deny。

这些结果按问题类型登记到 [TODO.md](../../TODO.md) 的 LOG-001 至 LOG-008。它们都还没有修复，本次交付只做登记与文档补齐。

| 项目 | 11:25Z 基线 | 11:47 快照 | 增量 |
|---|---:|---:|---:|
| 1.16.3 调用（去重） | 4 161 | 4 876 | +715 |
| 其中 defer | 4 153 | 4 868 | +715 |
| 实际 deny | 6 | 6 | 0 |
| 实际 ask | 2 | 2 | 0 |
| 1.16.2 调用 | 932 | 932 | 0 |
| 1.16.4 调用 | 0 | 0 | 0 |
| fallback 失败 | 26 | 31 | +5 |
| reported-error | 88 | 91 | +3 |
| 通信 `guard-not-registered`（观察） | 116 | 128 | +12 |

基线的 26 次 fallback 失败是 25 次 unsupported 加 1 次 `TRANSPORT`。当前累计的 55 次回退里，30 次 unsupported 全部失败，25 次 DeepSeek 回退有 24 次成功、1 次 `TRANSPORT` 实际 deny。

## 1. 窗口与去重口径

- 固定基准仍是上一份审计的 `2026-11-17T11:25:00Z`（北京时间 19:25），只用于算增量；完整窗口从 `1.16.3` 发布时刻起算。
- 同一 session 的同一次调用会先出现 pre、后出现 result。直接累加 pre/result 而没有去重，会把一次调用算成两次；只看 pre 又会缺少结果。去重按 session 与 call 合并，保留带最终动作的记录。
- 非 authorize 记录缺少关联字段，不并入这些调用的分母，也不用它重算总数。当前给不出“全部日志事件”的总量，只能给可关联的调用统计。
- 截止附近有 5 条只有 pre 的单行记录。它们不能当作结果泄漏，也不能证明调用失败；基线已经出现过迟到 result 的实例（基线 pre 行 62284 到新 result 行 62410），这类记录等下一次快照再定。
- telemetry 和捕获日志的截止相差 21 秒，本报告所有调用计数来自 telemetry 去重结果，捕获日志只用于行号、候选与消息核验。

## 2. 版本与实际动作

| 版本 | 调用 | defer | 实际 deny | 实际 ask |
|---|---:|---:|---:|---:|
| 1.16.3 | 4 876 | 4 868 | 6 | 2 |
| 1.16.2 | 932 | 931 | 1 | 0 |
| 1.16.4 | 0 | 0 | 0 | 0 |

1.16.4 的发布只说明 npm 上已有新版，本机插件仍是 1.16.3。没有 1.16.4 的遥测，也就没有新版线上行为可写。

## 3. 实际拒绝与询问样本

原始参数纯函数回放覆盖 8 个权限调用：1.16.3 的 5 次 privileged deny 和 2 次实际 ask，加 1.16.2 的 1 次 destructive deny。fallback 与通信样本只依据脱敏日志归类，不称原始回放。分类如下：

- 3 次 privileged deny 是同模式 `full=full` 声明，属于误判。1.16.4 只覆盖这一类。
- 2 次 privileged deny（行 53982-83、54010-11）的实际有效权限是 full，请求的是 workspace-write。宿主 `escalation.ts:209-219` 与 `WIDER_MODES:64-67` 对这种组合返回 `SANDBOX_ESCALATION_INVALID_ARGUMENT`，不是发起审批。问题在分类和提示，不能因为请求更窄就静默放行，越级仍然要拒绝。
- 2 次实际 ask 都是同模式声明（write、pwsh），也属于 1.16.4 修掉的误判点。canonical 上下文缺失，回放无法保证放行后命令一定执行成功。
- 1.16.2 的 1 次 destructive 实际 deny（行 53461-62）是隔离目录里的真实删除，不应放开。
- 1 次 `TRANSPORT` 实际 deny（行 53801-02）保持 fail-closed，转入 LOG-005。
- 1 次 unsupported 回退失败的代表样本在行 56284，归入 fallback 一节。
- 消息核验的 `descendants-query-failed` 代表样本在行 60179-80，归入 LOG-006。

1.16.4 的改动只涉及同模式声明与错误提示，不修上面这些独立故障。列出的 8 个权限样本来自当前 1.16.4 纯函数的反事实回放，不是新版线上验证；fallback 和通信只依据脱敏日志归类。

## 4. fallback 失败

| 回退选择 | 次数 | 成功 | 失败 | 本次新增 |
|---|---:|---:|---:|---:|
| `codex-proxy` / `codex-auto-review` / `off` | 30 | 0 | 30 次 `UNSUPPORTED_REASONING_EFFORT` | 5 次失败 |
| DeepSeek 回退 | 25 | 24 | 1 次 `TRANSPORT` 实际 deny | 0（基线前已存在） |
| 合计 | 55 | 24 | 31 | 5 次失败 |

新增失败分别从行 62397、62405、62640、62878、62885 开始，选择项和错误码都相同；先前 unsupported 的代表样本在行 56284。DeepSeek 组的 25 次在 11:25Z 基线前已经存在，增量是 0；本次只有 `codex-proxy` / `codex-auto-review` / `off` 这一组新增 5 次失败。所有 fallback 失败都没有被复用；这里没有“失败裁决被缓存”的迹象。

缓存零命中只能算观察，不能推出缓存回归。要回答这个问题得做正向测试：同 session 同参数在 120 秒内复用，以及失败裁决不复用，见 LOG-008。

白名单只读取了这些非敏感键：`mode`=`shadow`、`pointAuthorize`=`observe`、`guardFallback`=`model`、`guardFallbackProvider`=`codex-proxy`、`guardFallbackModel`=`codex-auto-review`、`guardFallbackReasoningEffort`=`off`。`off` 是 `guardFallbackReasoningEffort` 的推理档位，不是自动审查开关；没有展开或改动整份配置。

## 5. 通信核验与 reported-error

通信侧的 `guard-not-registered` 从 116 增加到 128，全部是观察候选，本来就在预期内，不列为新 bug。另有 verified 3 次、`descendants-query-failed` 1 次（行 60179-80），后者转入 LOG-006。

reported-error 新增 3 条，累计 91，新增工具是 edit、read、`pdwsh`。`pdwsh` 是日志中的真实工具名，不按标准名改成 `pwsh`；样本在行 63072-73，新 reason 是 `host-tool-access-denied`，但实际 action 是 defer，并带 EO error，不是插件 deny。仅凭记录结构分不清“未知工具”还是“宿主权限拒绝”，不能直接定性为拼写错误。91 条 reported-error 也不等于 91 次拦截，转入 LOG-007。

候选与实际仍要分开看：捕获日志新增 748 行，全部属于 1.16.3；28 个 candidate deny 全部是 shadow 候选，没有一条落到 enforce 的实际 deny。候选数不能当拦截数，相关证据缺口转入 LOG-004。

## 6. 证据缺口

- 调用明细里 `currentMode` 可从 `audit.permission.sandboxMode` 读到；`hostFinalAction` 字段存在但恒为 `unknown`。真正缺的是独立 `requestedMode`、canonical 判定、`roots` 和部分关联字段，多数记录只能从 reason 和最终动作反推当时发生了什么。
- 非 authorize 记录没有关联字段，既不能并入调用分母，也不能可靠地跨记录还原一次完整授权。
- 截止附近的单行 pre 不能当泄漏，需要等下一次快照看 result 是否迟到。
- telemetry 与捕获日志相差 21 秒，跨这两个来源的计数不能直接相加。
- 没有 1.16.4 的遥测，本机也没有升级，所以新版线上行为仍是空白。

## 7. 本轮边界

统计环节只读；文档交付的测试与提交由根流程另行记录。未改代码、配置、安装状态或原始日志，也没有推送。样本回放是反事实检查，不是线上验证。所有行号都可回到只读扫描记录核对，原始 JSONL、路径正文和调用参数没有复制进本文。

## 8. 对应待办

| 编号 | 优先级 | 状态 | 主题 |
|---|---|---|---|
| LOG-001 | P1 | 已确认配置/兼容性问题 | fallback 的 effort 能力校验与 off 失配 |
| LOG-002 | P1 | 已确认分类/提示缺陷 | 非同级无效权限请求与真正提权混在一起 |
| LOG-003 | P1 | 需授权 | 本机升级 1.16.4 与只读 canary |
| LOG-004 | P2 | 需调查/补观测 | 候选、实际、模式、关联和宿主最终动作的证据缺口 |
| LOG-005 | P2 | 需调查 | `TRANSPORT` 回退失败 |
| LOG-006 | P2 | 需调查 | 内部消息 `descendants-query-failed` |
| LOG-007 | P2 | 需调查 | 工具参数与宿主访问错误归因 |
| LOG-008 | P2 | 需正向验证 | 缓存复用，零命中不构成回归证据 |

问题描述、下一步和验收条件见 [TODO.md](../../TODO.md)。
