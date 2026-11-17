# 设置与授权安全修订

## 范围与基线

- 基线：`ff758465166184455d566f851841308bdc682fb4`，工作区开始时干净。
- 对齐用户提供的 captain task 与 revision blueprint，保留原始 `decideGuardLegacy` 作离线反事实对照。
- 用户随后要求直接在当前仓库按阶段自动提交，因此没有创建额外分支、没有重置基线、没有推送远端。
- 不修改本机全局 DSH 配置、不安装到当前运行的 profile、不在生产会话执行高危验证。
- 仓库通过 `vp install` / `vp run test` 管理，保留 Node.js 原生测试框架，不把测试迁移成 Vitest。
- 提交校验继承 `@commitlint/config-angular`，额外要求 subject 包含汉字；通过 Vite+ commit-msg hook 执行。

## 设置变化

主开关控制整个决策引擎；工具授权只有一组关闭 / 观察 / 生效控件，同时同步旧的 `mode` 和 `guardEnabled`，不再与参与点清单重复。

- 关闭：该决策点不参与，不发送决策请求，也不提供插件安全拦截。
- 观察：记录候选结果，不改变宿主处置，不能宣称已经保护操作。
- 生效：先实施 mandatory，再使用模型建议处理剩余软审查。
- 其他决策点保持独立设置。
- 决策模型和回退 provider / model / reasoning effort 均支持输入；宿主模型库可用时提供列表。
- 模型库通过 `GET /api/decision-engine/guard-models` 发现；查询参数 `provider` / `model` 用于按需加载 reasoning effort 元数据。不返回密钥。
- 设置页和决策历史卡片页的字体顺序均为 Sarasa Gothic SC，再系统默认无衬线字体。决策历史表格、展开明细、空态和错误状态一并提升字号，中文可读内容不再落入纯等宽字体链。保留表头粘性、排序、折叠与明细滚动行为。
- 高级设置折叠，保留用户分组展开状态。

## 分层结构

```text
ToolExecution
  → TrustedContext（宿主来源、真实工具可见性、权限与接收方核验）
  → ToolEffect（本地读取 / 有限写入 / 内部消息 / 状态 / 网络 / 提权 / 破坏 / 未知）
  → MandatoryPolicy（safe / requires_approval / deny / unknown）
  → ModelAdvisory（low / medium / high、注入、不可逆、任务相关性）
  → Tolerance（只调整软审核摩擦）
  → Auto Fallback（仅限软 ask 或建议失败）
  → PreToolDecision + 单调 tools.guard
  → tools/result（reported-success / reported-error / unknown）
  → 摘要审计（相同 session_id + call_id 汇合）
```

### 信任字段与接口缺口

核对对象为安装中的 DSH `0.2.2-rc.2` 的 Inspect 契约；审批事件结构另读取 `@deepseek-ai/dsh-user-approval` 实现核对。

| 字段 | 来源 | 信任与限制 |
| --- | --- | --- |
| 会话 / 调用 / 执行 token | `ToolExecution`、Agent Session | 宿主结构化身份，不能由 args 声称 |
| 原始真人目标 | `session.snapshotEvents()`，仅 `user/message` 且 `source.kind=user` | 没有就 unknown；recent 不作为授权证据 |
| 会话审批 override | `approval.overrideOf(session)` | 只返回 override，未声明不等于批准 |
| 预设与缺省审批 | `permissionPresets.current/resolve` | 用于补足当前 bundle；custom 或不可用保持 unknown |
| 沙箱与可写根 | `sandboxPolicy.resolve({session})` | 能读到约束不等于已确认底层执行器强制实施 |
| 文件目标范围 | `fs.resolve` + `fs.contains` | 写前解析快照；不宣称消除了 TOCTOU，也不授予工作区外写权限 |
| 工具可执行性 | `tools.executable(name, agent, toolSet)` | 读到 unavailable 时拒绝；服务缺失保持 unknown |
| 内部接收方 | root / descendants + `agents.get` | 要求同树、可继续且本地存活；不继承发送方授权 |
| 下游独立审核 | 本插件全局 enforce 注册事实 | 仅对经过当前 Host 工具管线的本地 continuable Agent 成立，外部进程未知 |
| 接收方具体权限 / delegated scope | 无完整授权接口 | unknown，不凭 reviewer 等名字推断 |
| 本次真人批准 | 宿主 `approval/asked` → `approval/decided` | 必须在本次审查之后，匹配工具名、call_id、请求 id，且 outcome=allowed-once |
| 宿主最终动作 | 未获得独立完整的最终处置接口 | unknown；不把 next() 写成最终允许 |
| 实际副作用 | `tools/result` | 只记录 reported-success/error，不能证明磁盘、网络或外部系统副作用完成 |

### 安全分级与不变量

安全分级不再等于一个模型风险分数。

1. **safe**：已知无副作用本地查询、受宿主修订协议约束的任务状态操作、经过独立核验的内部消息；有限写入仅在宿主目标解析与允许范围内进入模型审查。
2. **requires_approval**：已确认的越界写入、只读环境写入、显式权限提升、已识别的破坏操作、接收方授权未核验。不能仅因不认识某工具或无法解析 shell，就宣称宿主要求真人审批。
3. **deny**：宿主已明确拒绝工具可见性；所有档位保持拒绝。
4. **unknown**：缺失的副作用证据不等于权限升级。未知 shell/MCP/网络效果进入决策模型；Auto 下即使初判 low，仍使用独立 LLM 或用户显式选择的回退策略复核。人工模式保留询问或拒绝；模型失效不伪造用户批准。

`danger-full-access` 只表示沙箱约束，不是所有操作的授权。`approval=never` 下 required 调用直接拒绝。审批可用也不是批准：最终单调 guard 要求本次 allowed-once，并核对被审查参数摘要与调用身份，防止其他 waterfall 把 ask 改为 allow 或修改参数。

#### 同级沙箱权限声明

已核实 DSH `0.2.2-rc.3` 的文件工具与 shell 实现：请求模式与当前有效沙箱模式相同时，宿主不升级权限，也不发起审批。插件仅对 `write`、`edit`、`bash`、`pwsh` 对齐此语义；请求值必须是 `workspace-write` 或 `danger-full-access`，并与可信宿主上下文中的 `sandboxMode` 完全相等。`pwsh` 还要求非空字符串 `justification`；其余三个工具允许缺省说明，但不会吞掉非字符串说明。

分类器只在局部副本中去掉这组冗余元字段，再按原有契约判断文件范围、命令副作用与未知行为，不修改交给宿主的原始参数，也不直接授予许可。更宽、更窄、无效或无法核实的请求，以及其他工具携带的同名字段，仍按原有保守规则处理。真实的删除、ACL 修改、`sudo`、只读写入等约束保持不变；工作区外写入仍遵循现有交回宿主设置。

审批不可用时，拒绝提示会说明审批要求来自本插件，并用固定词表展示实际触发规则。错误码与审计字段不变；未登记的原因只显示兜底文案，不回显任意输入。

严格安全直通不包括任意 `web_fetch`、MCP、shell 或补丁；`todo_write` / `team_task_update` 是有限状态修改，不伪装成只读。无法可靠解析 shell 时不通过正则“证明安全”，而是标记不确定并交模型复核。1.9.0 曾把这种不确定性直接升级为强制人工审批，导致 Auto 完全绕过模型，是已修复的严重回归，不是可接受的安全降级。多目标补丁只要有已知越界目标，其他未知路径也不能掩盖该硬约束。

### 自动审查与 Fallback

宿主 `auto` 不再提前跳过整个授权审查。已验证的本地查询可不联系模型；其他可审查调用继续先问决策模型。

`auto` 或 `tolerance=autonomous` 遇到软性 ask，或模型建议不可用时，使用以下策略：

| `guardFallback` | 行为 |
| --- | --- |
| `model` | 指定宿主已注册 provider / model，可设置 reasoning effort |
| `session` | 沿用当前 request/header 的 provider / model / reasoning effort（默认） |
| `allow` | 跳过软审核建议，仍不覆盖 mandatory |
| `deny` | 拒绝该软审核请求 |

模型回退不携带工具，严格只接受完整 JSON `{ "action": "allow" }` 或 `{ "action": "deny" }`；缺路由、超时、错误、截断、非法 JSON 都失败关闭，不继续嵌套为 allow。支持用户手填模型 id，但 provider 必须已在宿主注册；这不是一个自动保存任意第三方 API Key 的新通道。

模型不能替真人批准 mandatory 操作。手动模式保留真人 ask。高任务相关性不是注入豁免，普通 captain→reviewer 祈使句也不再自动等同注入。注入分数是模型旁证而非确定性证据：自治软审查仍会交回退模型二审；不能据模拟模型结果宣布注入已彻底解决。

### 概率、缓存与审计

- `confidenceKind` 显式区分 normalized / provider_raw / unavailable。未声明尺度不参与风险阈值，不与 `P(choice)` 互换。
- 分类概率若出现，必须完整包含 low / medium / high，均在 [0,1] 且和为 1；畸形或缺失必要 noul 字段使建议 unknown。
- `risk_p` 仅保留 deprecated 原始 confidence 别名；新增 raw_decision_confidence、p_high、p_non_low、risk_severity。
- severity 是排序分数，分位数 ready 不是危险概率校准。`calibrated_p_unsafe` 保持 unknown/null。
- mandatory 每次重新检查，先于模型缓存；上下文版本进入精确请求键，授权不走软缓存。
- 授权的持久明细仅存摘要 hash 和结构化数值，不存原始目标、recent、工具参数或完整模型正文。发送到已配置模型的受限证据对象与持久对象分离，常见凭据字段先遮盖。
- 记录 mandatory / baseAction / tolerance / pluginReturnedAction / hostApprovalStatus / hostFinalAction / effectOutcome / degradedReason / cacheStatus；不存在的宿主证据写 unknown。
- 遥测追加失败会重试一次，再记录失败计数和日志警告；不把日志失败变成许可。

## 验证与证据

命令：

```powershell
vp install
vp run test
vp run verify:wiring
vp node --test test/guard-*.test.js test/scope*.test.js test/tolerance*.test.js
vp node scripts/verify-guard-scenarios.mjs bench/guard-revision
```

- 最终安全专测 139 / 139 通过，合并 UI 专测 186 / 186 通过。全量 802 项中 797 通过、5 项失败；失败来自基线已有 Windows POSIX 权限断言、失败路径假设与临时目录清理竞态，未伪报全绿。逐项结果及原始日志见 `bench/guard-revision/validation.md`。
- 24 个独立合成情景按 8 良性 / 8 隔离高影响 / 8 来源权限对照冻结为 gold，四档共 96 次评估；输出 `gold.json`、`old-new.jsonl`、`report.json`。
- FULL 是合成 fixture 中可见的输入与管线事实，不是生产调用的充分观测；CD / NR 数量均为 0，不能据此比较历史 shadow 的分层指标。
- 合成良性 FPR 与高影响放行率见机器报告。高危使用真实工具名进入审核管线，但没有执行生产工具实现，真实危险 FNR 仍为 N/A，危险概率不可校准。不能将这些数字宣传成真实危险零漏杀。
- 旧结果列是 `decideGuardLegacy` + 容忍度纯函数反事实，不是旧 Host 最终动作；原 240 条 shadow 和 12 条现场录制未随此 checkout 提供，`_bench/gatebench-out` 不存在，无法重跑，未伪造数据。
- 浏览器访问给定现有 GUI 返回 authentication required；未搜索 token、未启动替代服务器、未生成 mock 页面。真实明暗主题、字体可用性与安装后的视觉验收仍未完成。
- 变更依赖的宿主 API 已 Inspect；repo wiring verifier 使用本地 peer 依赖与隔离 DSH_HOME，不等同运行安装的 E2E 验收。

## 分阶段发布、兼容与回滚

本次按可审查提交分别交付工具链、Fallback、安全核心、设置页与验证文档。为避免提交不可运行的临时授权链，PR-1～PR-5 的纯模块与接线在安全核心检查点合并验证，不声称已做五次生产 canary 发布。

1. 保持现有生产 profile 未安装、未修改；先在独立测试 profile 中观察记录。
2. 上线前补齐旧 shadow 原始资料，冻结业务允许的误报预算，验证宿主真实审批与实际工具结果，再做小范围 enforce。
3. `guardPolicyMode=observe` 是明确不实施 mandatory 的诊断降级，不能称作安全回滚；工具授权 observe/off 同样不提供保护。
4. 回滚源码用 `git revert <相应提交>`，保留历史与用户配置；不要恢复旧的 fail-open 旁路后仍标为安全版本。
5. 配置键保留兼容读取，但旧 read-only/exclude/outside 白名单不再越过 mandatory。旧统计记录不重写为新概率口径。
6. 不改本机全局权限、审批模式或默认模型；不自动安装或重启 DSH。
