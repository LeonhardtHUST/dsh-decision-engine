# TODO

> 本次交付：`1.16.5` 发布与官方包核验、P1 修复的验收记录和文档收敛，不是 9 个问题已关闭。
>
> 本清单登记 2026-11-17 发布后审计确认的问题和待授权动作。数据截止、窗口和样本边界见 [审计报告][审计]。`1.16.5` 已发布并成为 latest，含 P1 修复代码，官方 tarball 的 lib 与 release 源码逐字节一致。当前 profile 仍是旧 npm `1.16.4`，新修复没有安装、重启或 canary。下面 9 项都未解决，LOG-001 和 LOG-002 只完成了仓库与发布部分。

19:47 历史日志快照（非实时）：

- 线上 `1.16.3` 完整窗口 4 876 次调用，defer 4 868、实际 deny 6、实际 ask 2；相对 11:25Z（北京时间 19:25）基线新增 715 次去重调用，全部 defer，新增实际 deny/ask 为 0。
- npm `1.16.4` 于该快照时已是 latest，快照里 1.16.4 为 0 次（历史口径，不代表当前）。
- fallback 累计 55 次、失败 31 次；通信 `guard-not-registered` 128 次均为观察候选；reported-error 累计 91 条。

当前发布状态（2026-11-17 本轮对官方 registry 的只读核对）：

- `1.16.5` 于 UTC `2026-11-17T13:44:20.226Z`（北京时间 21:44:20）发布，exact 与 latest 均为 `1.16.5`，`checkedAt` 为 `13:45:30.635Z`。最初 exact 查询一度 404，随后 packument 与 tarball 公开可用，属于传播延迟，不另登记问题。
- 发布源提交 `38f0d87019ab3b1ab275dc8faa8f39f7499a88db`；CI 入口 https://github.com/LeonhardtHUST/dsh-decision-engine/actions/runs/44095170847 通过，发布工作流 https://github.com/LeonhardtHUST/dsh-decision-engine/actions/runs/44095170831 通过（OIDC + `--provenance`）。发布前 CI 入口 `vp run verify` 为 1365/1365 并带接线检查，96/96 隔离安全情景通过，frozen install 与包校验通过。默认直接 `node --test` 的发现范围比 CI 入口多 1 项 helper，所以是 1366；Windows 临时目录清理 `EPERM` 仍登记为 LOG-009，没有修。
- 官方 tarball https://registry.npmjs.org/@leonhardthust/dsh-decision-engine/-/dsh-decision-engine-1.16.5.tgz 共 75 文件、1 548 036 B；44 个 lib 文件与 release 源码逐个核对后字节相同；`sha1 9ea127bde303ffb1fe3a3a75da27487f73e0a47b`，`integrity sha512-I65vc0DU48wLLIj66dKpsdwmaq7/1E3t6h6kp+EZbZfn/y0ai2CiQiND6Z0kBu55rWoMWfdA688IOEC2jT/vhA==`。
- SLSA 信封内容已匹配 repo/main、`.github/workflows/publish.yml`、commit 和 artifact digest；密码学签名验证没有执行，不能把信封内容匹配写成签名完全验真。

当前运行状态（本次只读核对，与上面历史快照和发布状态分开）：

- 当前 profile 的依赖声明与已装模块版本仍为本机旧 `1.16.4`；`1.16.5` 没有安装、没有重启，也没有 canary。
- telemetry 从 UTC `2026-11-17T12:48:58.964Z`（北京时间 20:48）起出现 `pluginVersion=1.16.4`，这是旧包在本机的首条记录，保留为历史上下文；审查时统计约 776 条 telemetry、412 条日志，不作为最新完整计数。
- 该旧包没有 `lib/guard/fallback-capabilities.js`，lib 文件内容与仓库不同；`48d6f4b` 晚于该版本，所以旧包的运行记录不能证明本次 P1 修复上线。`1.16.5` 已含修复代码，安装与线上验证另行授权。

## 本轮进行中

- 本轮阶段 1 的 LOG-001 与 LOG-002 代码修复已完成，并通过独立只读验收。已提交 `48d6f4b`、`bf6295c`；随后以 `38f0d87` 发布 `1.16.5`，官方包核验通过。新修复尚未安装，当前 profile 仍为旧 `1.16.4`；`off` 配置失配仍待单独授权处理，线上新修复行为未验证。
- LOG-001 的仓库与发布部分已完成，但当前 `off` 配置与模型能力失配仍需单独授权处理，不能整体勾选。
- LOG-002 的仓库与发布部分已完成；线上效果要等授权安装 `1.16.5` 后再做 canary。
- 下一步：LOG-003 申请安装 `1.16.5`、重启并做只读 canary；LOG-009 另行调查；随后处理阶段 2（LOG-004 脱敏字段）与阶段 3 调查（LOG-005/006/007，LOG-008 正向验证）。

## 待解决

- [ ] **LOG-001 P1 fallback effort 能力校验与当前 off 配置失配**
  - 状态与证据：仓库代码修复已完成，独立只读验收通过，并随 `1.16.5` 发布（官方包 44 个 lib 文件与源码逐字节一致，包内含 `fallback-capabilities.js`）。`vp exec node --test --test-timeout=60000 test/guard-*.test.js` 为 484/484，隔离安全情景为 96/96，`vp run verify:wiring` 通过；默认并发全量测试有 Windows 临时目录清理 `EPERM`，串行运行 1366/1366 通过。已确认配置/兼容性问题仍未处理：30 次 `codex-proxy` / `codex-auto-review` / `off` 回退全部失败，本次新增 5 次，均返回 `UNSUPPORTED_REASONING_EFFORT`（日志行 62397 起）。宿主已在 provider I/O 前校验并拒绝。预检语义：显式 effort 不被所选模型支持时，在 `llm.stream` 前失败；元数据无效或无法核实时保守失败；未显式配置 effort 时交宿主默认；旧宿主没有 `resolveModelInfo` 时保留 SDK 原校验路径，不算能力预检通过。不自动改模型或 effort，失败不缓存。当前 `off` 与所选模型能力不一致仍需单独授权处理。证据见 [审计报告][审计] §4、[工程方案][工程方案] §2 与 [回退实现][回退实现]。
  - 下一步：代码与发布已完成；下一步处理配置失配；如升级旧宿主兼容，需验证。更换模型或 effort 属于配置变更，需单独授权，本轮不擅自改。
  - 验收：fixture 覆盖不支持与支持两组；不支持值在设置或进入回退前被明确校验并给出可操作提示，不重复触发 `llm.stream`；支持值正常回退；失败裁决不缓存、不复用。

- [ ] **LOG-002 P1 非同级无效权限元字段与真正提权混在一起**
  - 状态与证据：仓库代码修复已完成，独立只读验收通过，并随 `1.16.5` 发布、官方包核验通过。Guard 定向测试为 484/484，隔离安全情景为 96/96，覆盖同级、无效值/类型、更窄请求、真实越级和未知工具；`full → workspace-write` 现在归无效参数并本地拒绝，真正越级仍保留原审批边界。本次修复的线上效果须在授权安装 `1.16.5` 并完成 canary 后验证，当前 profile 仍是旧 `1.16.4`。证据见 [审计报告][审计] §3 与 [工程方案][工程方案] §2。
  - 下一步：待 LOG-003 授权安装并验证。更窄的无效请求不能静默放行，越级继续拒绝，宿主最终边界不变。
  - 验收：fixture 覆盖同模式、无效值、更窄、越级和未知工具；拒绝提示说明实际触发项；错误码兼容，未知权限不放宽。

- [ ] **LOG-003 P1 本机安装 1.16.5、重启与只读 canary（待用户授权）**
  - 状态与证据：`1.16.5` 已于 UTC `2026-11-17T13:44:20.226Z` 发布并成为 latest，官方包包含 P1 修复代码并通过核验。当前 profile 依赖与已装模块仍是旧 `1.16.4`，没有安装、重启或 canary；本机安装与运行验证需用户另行授权。19:47 历史快照里 1.16.3 的数字见 [审计报告][审计] §2。
  - 下一步：取得授权后安装 `1.16.5`、重启，再做只读线上 canary。未授权前不安装、不重启、不开高危测试。
  - 验收：重启后版本日志显示 `1.16.5`，且已装包含 `fallback-capabilities.js`；canary 只做只读调用，确认没有新增实际 deny/ask；没有真实删除、提权或外网副作用。

- [ ] **LOG-004 P2 候选、实际、模式、关联和宿主最终动作的证据缺口**
  - 状态与证据：需调查并补观测。捕获日志新增 748 行全属 1.16.3，28 个 candidate deny 全是 shadow 候选，enforce 实际 deny 为 0。`currentMode` 可从 `audit.permission.sandboxMode` 读到，`hostFinalAction` 字段存在但恒为 `unknown`；真正缺的是独立 `requestedMode`、canonical、`roots` 和部分关联字段，证据见 [审计报告][审计] §5、§6。
  - 下一步：补齐独立 `requestedMode`、canonical、`roots` 和部分关联证据；解释 `hostFinalAction` 恒为 `unknown` 的原因，非 authorize 记录单独建模，不混入调用分母；不记录原始路径或正文。
  - 验收：任取一条调用能回答候选、实际、模式和宿主结果；非 authorize 有独立分母；新增字段通过脱敏审查。

- [ ] **LOG-005 P2 TRANSPORT 回退失败调查**
  - 状态与证据：需调查。DeepSeek 回退 25 次中 24 次成功，1 次 `TRANSPORT` 实际 deny（行 53801-02）；所有 fallback 失败都没有被复用。证据见 [审计报告][审计] §3、§4。
  - 下一步：定位 `TRANSPORT` 的触发条件，分清网络、协议和超时。保持 fail-closed，不为减少 deny 放宽传输失败。
  - 验收：能复现或稳定归类 `TRANSPORT`；失败仍不写缓存、不复用；不把单次传输失败写成缓存回归。

- [ ] **LOG-006 P2 内部消息 descendants 查询失败**
  - 状态与证据：需调查。通信核验的 `guard-not-registered` 从 116 增至 128，全部是观察候选，属预期；另有 verified 3、`descendants-query-failed` 1（行 60179-80）。证据见 [审计报告][审计] §3、§5。
  - 下一步：确认 root 目标是否必须发 descendants 查询，能省则省；不要为了消掉观察项改放行条件。
  - 验收：复现该失败并说明是否 root 特例；只对已由其他宿主证据核实的 root 目标，避免无关 descendants 查询失败造成误拦；核验不完整的目标仍按原权限边界拒绝或要求审批，不得因查询失败一律放行；fixture 同时覆盖“已核实目标”和“核验不全目标”两例；128 个观察候选不再被当作缺陷计数。

- [ ] **LOG-007 P2 工具参数与宿主访问错误归因**
  - 状态与证据：需调查。reported-error 新增 3 条、累计 91，新增工具是 edit、read、`pdwsh`。`pdwsh` 是日志中的真实工具名，不按标准名改成 `pwsh`；样本行 63072-73 的 reason 是 `host-tool-access-denied`，实际 action 是 defer 且带 EO error，不是插件 deny。证据见 [审计报告][审计] §5。
  - 下一步：找到原调用和实际工具目录，区分未知工具与宿主权限拒绝，再决定补契约还是修提示。91 条 reported-error 不等于 91 次拦截。
  - 验收：样本能归因到具体工具和宿主动作；未知工具与权限拒绝各有 fixture；不凭字段结构直接定性为拼写错。

- [ ] **LOG-008 P2 缓存复用正向验证**
  - 状态与证据：需正向验证。当前零 cache hit 只是观察，fallback 失败未复用；没有证据支持缓存回归。证据见 [审计报告][审计] §4。
  - 下一步：做正向测试：同 session 同参数 120 秒内复用，以及失败裁决不被复用。不要用零命中反推回归。
  - 验收：正向复用命中且记录来源、耗时正确；失败不缓存；测试完成前不写回归结论。

- [ ] **LOG-009 P2 Windows 并发测试临时目录清理稳定性**
  - 状态与证据：待调查。默认并发全量测试 1/1366 失败，为 Windows 临时目录清理 `EPERM`；串行 1366/1366 通过。`engine.test.js` 的旧 baseline 已出现同类 `EPERM`，因此不归为 P1 回归。
  - 下一步：调查测试临时目录清理的竞争，建议隔离 cleanup 或加有限重试；只动测试可靠性，不改业务逻辑。
  - 验收：Windows 上默认并发连续跑 3 轮无 `EPERM`，或明确隔离 cleanup/重试；不与 P1 回归混在一起。

## 本轮已完成

- 纪律补齐：[AGENTS.md](AGENTS.md) 加入目标与 todo、现场证据、never 不填提权参数、失败止损、脏文件保护、独立只读验收、推送/发布/安装授权、usage 真实性；[docs/releasing.md](docs/releasing.md) 与 [docs/local-dev-link.md](docs/local-dev-link.md) 去掉无条件提权提示和危险还原指引。
- 审计刷新：固定 telemetry `11:47:17.406Z` 与捕获日志 `11:47:38.057Z` 两个截止，记录完整窗口、715 增量、fallback、通信、reported-error 和样本边界，见 [审计报告][审计]。
- 待办登记：LOG-001 至 LOG-009 全部未解决，均带优先级、脱敏证据和验收条件。
- 阶段 1 修复与发布：LOG-001、LOG-002 代码修复通过独立只读验收，随 `1.16.5`（源提交 `38f0d87`）发布，官方 tarball、exact/latest 和 lib 字节一致性核验通过。
- 尚未完成：LOG-001 至 LOG-009 均未关闭；当前 profile 仍是旧 npm `1.16.4`，新修复没有安装、重启或 canary；`off` 配置失配待授权。

## 下次接手

先看 [审计报告][审计] 的结论、窗口和实际拒绝一节，确认基线、版本和样本边界。当前事实：`1.16.5` 已发布并成为 latest，官方包核验通过；本机仍是旧 `1.16.4`。LOG-003 下一步是申请安装 `1.16.5`、重启和只读 canary 的授权；LOG-001 的 `off` 配置失配另需授权；LOG-009 只涉及测试可靠性，另开任务；LOG-004 的字段补齐可能需要改代码，另开任务。候选 deny、零缓存命中和 reported-error 都不能直接当成实际拦截或回归证据。

[审计]: docs/audits/2026-11-17-post-release-log-audit.md
[回退实现]: lib/guard/fallback.js
[工程方案]: docs/engineering/2026-11-17-audit-remediation-plan.md
