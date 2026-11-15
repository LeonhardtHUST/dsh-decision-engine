# 本地审批日志审计：分版本问题清单与解决方案

> 审计对象：本机 `~/.dsh/dsh-decision-engine/` 下的授权（`point=authorize`）日志与遥测。
> 方法：只读分析 + 代码交叉验证；不改插件源码、不改配置、不推送。
> 数据快照：2026-11-15 17:06–17:21（明细持续追加，数字按快照固定）。
> 分析脚本与两份原始分析记录：`tmp-audit/`（未入库）。

## 0. 结论速览

1. **审批日志本身没有版本字段**，所以本次按「npm 发布时间 + 本机安装清单 + 日志 schema 断点」推断版本窗口；1.14.0 已发布（17:14）但本机仍装 1.13.0（16:09 安装），1.14.0 无运行数据。
2. **1.9.0–1.9.1 是误拒重灾区**：拒绝率 15.3% → 23.2%，主因分别是「unknown 一律按需审批」和「模型答案形状不符且无回退」；1.9.2 加回退后降到 2.8%。
3. **1.9.x 曾把 27 次 ask 丢进「没有审批通道」的会话，100% 被宿主直接拒绝**（edit 26、write 1）；1.11.2 修复后不再出现。
4. **当前 1.13.0 的主要问题不再是「问太多」，而是「直接拒」**：0 次 ask、25 次 deny，其中 **10 次发生在插件自己判定 `mandatory=safe` 的 write/edit 上**；审计期间（17:09–17:18）现场就发生 14 次 `model-material-risk` 拒绝，重试后又能通过。
5. **判定不稳定 + 重试风暴**：160 次拦截中 100 次（62.5%）在 120 秒内重试同一工具，累计 533 次；其中 31 次在 120 秒内被重新放行——同一调用「先拒后放」。
6. **观测口径问题仍然存在**：`reasonCode` 被写成含中文阈值的长句（61 种取值）、`hostFinalAction` 从未回填（100% unknown）、遥测一次调用写两条记录且无 `mode`、观察模式明细写的是「拟执行动作」、缓存命中 0（设计使然）。

---

## 1. 数据与版本口径

### 1.1 数据源

| 文件 | 大小 | 内容 | 本次用途 |
|---|---|---|---|
| `logs/2026-11-1{3,4,5}.log` | 约 16 MB | 决策明细（按日期分片，含 `mode`/`scores`/`content`） | 主数据：authorize 6 175 条（17:06 快照；17:24 已增至 6 552） |
| `telemetry.jsonl` | 约 28 MB | 遥测（v1 无 audit；v2 带 `guard-audit-v1`） | 宿主结果对照：13 556 行（v2 去重后 3 893 次调用） |
| `stats.jsonl` | 约 3 MB | 裁决统计（写盘口径） | 交叉校验：8 041 行 |
| `decisions.jsonl*.migrated` | 约 14.6 MB | 迁移前的旧单文件备份 | 仅确认「logs 已包含旧记录」，未重复计数 |

合计扫描：明细 6 873 条记录（其中 authorize 6 175 条，17:06 快照；17:24 已增至 6 908 / 6 552）、遥测 13 556 行、统计 8 041 行；解析失败 0 行。日志仍在追加，计数会小幅上漂，结论不受影响。

### 1.2 为什么必须分版本，以及版本是怎么判定的

**直接证据（可复核）**

- 日志记录**没有** `pluginVersion` / `commit` 字段，无法从日志直接读出版本。
- 本机安装清单：`~/.dsh/profiles/desktop/package.json` 锁定 `@leonhardthust/dsh-decision-engine@1.13.0`，文件 mtime 为 **11-15 16:09:06**；安装目录内 `package.json.version = 1.13.0`。
- npm 发布时间（`npm view ... time`，已换算 UTC+8）：

| 版本 | 发布时间（+08） | 版本 | 发布时间（+08） |
|---|---|---|---|
| 1.9.0 | 11-14 22:13 | 1.11.1 | 11-15 14:38 |
| 1.9.1 | 11-15 00:39 | 1.11.2 | 11-15 15:22 |
| 1.9.2 | 11-15 10:01 | 1.12.0 | 11-15 15:42 |
| 1.10.0 | 11-15 13:40 | 1.13.0 | 11-15 16:07 |
| 1.11.0 | 11-15 14:02 | 1.14.0 | 11-15 17:14（未安装） |

**间接证据（日志 schema 断点，用于识别「发布间隔里的本地构建」）**

- 11-14 16:41 起，明细 `scores` 首次出现 `decisionSource / mandatory / confidenceKind / reviewMode`，早于 1.9.0 发布 → 该窗口运行的是**未发布的本地构建**（记为「1.9 预览」）。
- 11-15 13:16 起出现按日期分片（1.10.0 的「决策日志分目录」）；同一时期 `tolerance` 文案由「属最前的 1%」变为「落在严重度尾部」、并引入稳定码 `tolerance-ask`。
- 1.13.0 窗口内 `guardFallback` 行为与安装时间吻合（16:09 安装后立即出现 `fallback-model-deny` 记录）。

因此：**版本窗口 = 发布/安装时间**；发布与下一次发布之间若出现 schema 断点，如实标注为「本地构建」。这满足「无法直接划分时按发布时间划分」的口径，但**不能把窗口边界当成精确的代码切换点**（见 §6）。

### 1.3 版本时间线与规模

| 版本窗口（+08） | authorize 记录 | 主要配置态 | 关键观测 |
|---|---:|---|---|
| v1.8.x（≤11-14 16:41） | 647 | enforce；tolerance=relaxed | ask 1.5%；0 deny；p50 167ms |
| v1.9 预览（11-14 16:41–22:13） | 1 800 | enforce；tolerance 混合 | ask 7.9%（142 次），协调工具占 78 次；0 deny |
| v1.9.0（22:13–00:39） | 189 | enforce | **deny 15.3%（29 次）**；ask 17.5% |
| v1.9.1（00:39–10:01） | 168 | enforce | **deny 23.2%（39 次）**；模型失败 21 次 |
| v1.9.2（10:01–13:40） | 1 772 | observe 1 560 / enforce 212 | 回退 611 次；deny 63（enforce 内 2.8%）；p50 1.7s |
| v1.10.0（13:40–14:02） | 201 | 全 observe | 回退 72；拟 deny 7；p50 2.5s |
| v1.11.0（14:02–14:38） | 345 | enforce 189 / observe 156 | deny 21；recipient ask 5 |
| v1.11.1（14:38–15:22） | 331 | enforce；policy=never | **ask 0**；deny 6；接收方误判 4 |
| v1.11.2（15:22–15:42） | 298 | enforce；never | ask 0；deny 2；回退 25 |
| v1.12.0（15:42–16:07） | 288 | enforce；never | ask 0；deny 3；max 20.5s |
| v1.13.0（16:07–17:21） | 417 | enforce；never；sandbox=danger-full-access | **ask 0；deny 25**；其中 10 条 `mandatory=safe` |
| v1.14.0 | 0 | 已发布未安装 | — |

> 除 1.9.2 外，后半段每个版本窗口只有 200–400 条记录（10–40 分钟），**比例噪声大**；下表凡引用比例都同时给出计数。

### 1.4 口径陷阱（否则会读错日志）

1. **明细与遥测是两套口径**：明细写 `action = action.kind`（observe 时仍写 `deny/ask`），遥测写 `pluginReturnedAction`（observe 时写 `defer_to_host`）。同一次调用在明细里像「被拦」，在遥测里只是「交给宿主」。明细中 `observe=>deny 74`、`observe=>ask 36` 属于**观察模式的拟执行动作**。
2. **遥测 v1/v2 不可混算**：v1（5 428 条）无 `audit`，无法对照宿主结果且 `deny=0`；v2（7 779 条 = 3 893 次调用）每条调用写两条记录（决策 + 结果回填），无 `mode`。按记录直接统计会把 ask/deny 虚高一倍。
3. **`hostFinalAction` 从未回填**（100% unknown），`effectOutcome` 没有 `succeeded`，只有 `reported-success/reported-error`；不能说「宿主本会允许」有直接证据，只能给间接证据（§3.1）。
4. **`.migrated` 是重复备份**：与 `logs/` 逐 id 重叠 5 213/5 214；`logs/` 已完整，无需再读备份，但备份本身没被清理。
5. **明细 `seq` 不是全局唯一**：会话恢复/插件重启后从 1 重新计数，`sessionId+seq` 有 233 个重复键，但 `id` 唯一（不是重复写盘）。

---

## 2. 分版本结论

### v1.8.x（≤11-14 16:41，647 条）

- **没有 fail-closed 拒绝**：0 deny、0 回退、0 模型失败拒绝；ask 仅 1.5%（10 次）。
- **但已存在协调工具误问**：`send_message` 6 次、`plugin_manager`/`subagent_*` 各 1 次；ask 文本仍是旧版「中风险调用，需人工确认（risk=…）」。
- **审计字段缺失是版本演进**，不是分支漏填：该窗口记录没有 `decisionSource/mandatory/confidenceKind/reasonCode`，`scores` 是旧形状（`{risk_p, irrev, task, inj, tolerance:{…}}`）。
- **结论**：此阶段「宽进」但观测能力弱；任何跨版本聚合若把这段与新版混算，`(none)` 会占满分母。

### v1.9 预览（11-14 16:41–22:13，1 800 条，未发布本地构建）

- **问询量最大**：ask 142 次（7.9%），其中协调类工具 78 次（`pwsh` 32、`edit` 27、`team_task_update` 21、`send_message` 20、`team_task_get` 12、`list_agents` 5、`wait_agent` 4…）。
- **误报类型已经成型**：`send_message` 因「疑似提示注入」（inj=0.81–0.86）被升级；`subagent_fast` 的提示词本身被判注入；`team_task_get/list_agents` 被判「中风险」。
- **仍未产生 deny**：安全层次（mandatory/回退）尚未接入，ask 是唯一升级手段。
- **结论**：这是「审批噪声」问题的起点；后续 1.11.1 只修了 recipient 一类，**注入/中风险路径并未根治**（见 §3.3）。

### v1.9.0（11-14 22:13–00:39，189 条）

- **拒绝率 15.3%（29/189）**，几乎全部是 `pwsh`（23 次），拒绝原因（当时尚无 `reasonCode` 字段，取 `detail`）为 `unknown-high-impact-effect-requires-approval`（26 次）。
- 这是安全改造的第一次「过度收紧」：**本地静态规则判不出副作用的命令一律按「需要审批」处理**，而审批通道是 `never`，于是直接拒绝。
- 同时 ask 17.5%（33 次），说明同一批会话里「问」与「拒」并存，用户无法预测。
- **结论（已修复）**：1.9.1 起把这类情况改为 `unknown + 模型复核`（`policy.js:26` 现状），不再默认要求审批。

### v1.9.1（11-15 00:39–10:01，168 条）

- **拒绝率升到 23.2%（39/168）**，拒绝原因（`detail`，同一窗口内多数记录尚无 `reasonCode`）为 `unresolved-effect-needs-model-review` 26 次 + `advisory-failed-unknown-effect` 12 次。
- 触发链：决策模型返回 **`answer-shape-mismatch`**（该窗口 21 次模型失败、总 24 次 shape 失败中绝大多数集中在此），而当时**没有可用的第二模型回退**，于是 fail-closed → deny。
- 失败工具：`pwsh` 21、`edit` 12；`edit` 的 12 次连续拒绝在 06:31–06:33（本地）集中出现，属于一次模型解析故障放大成一组硬拒绝。
- 同时出现**只读 MCP 误拒**：`mcp__blender__get_addon_status`（2）、`get_scene_info`（1）、`mcp__siyuan__system`（1）。
- **结论（1.9.2 修复）**：该窗口是「模型不可用 = 工具不可用」的典型；1.9.2 恢复回退模型后拒绝率降到 2.8%。

### v1.9.2（11-15 10:01–13:40，1 772 条；enforce 仅 212）

- 回退模型开始承担裁决：**回退 611 次（占该窗口记录 34%）**，其中 45 次回退后拒绝；deny 63（enforce 内 2.8%）。
- 回退把「模型失败 → 拒绝」改成「第二个模型审 → 放行/拒绝」；代价是延迟：**p50 1 705ms、p95 5 142ms、max 14 916ms**。
- 伴随两类误伤：`send_message` 以 `recipient-authority-unverified` 被 ask 18 次/deny 13 次；`mcp__blender__*` 仍有误拒。
- **结论**：安全可用性明显改善，但把「误拒」换成了「慢」与「协调工具误判」。

### v1.10.0（11-15 13:40–14:02，201 条，全 observe）

- 日志分片 + 安全档位重构上线；该窗口全为观察模式，拟 deny 7 次（`update_goal` 2、`pwsh` 4、`team_task_create` 1）。
- **`update_goal` 被回退模型拒绝**是此时出现的新误伤类型：目标维护属于内部状态，不应被当作危险操作。
- **结论**：observe 下的「拟拒绝」被写进明细，与真实拒绝不可区分（§3.5），从这一版起更明显。

### v1.11.0（14:02–14:38，345 条）

- 混合模式；deny 21。`recipient-authority-unverified` 仍 4 次，`tolerance` note 6 次，`model-material-risk` 1 次。
- **结论**：修复前的过渡态；协调工具误判仍在。

### v1.11.1（14:38–15:22，331 条）

- **`recipient-authority-unverified` 的 ask 从 18/7/5 次降为 0**（`90e5689`「空闲队友消息不再被误判为接收方权限未核验」）。
- 但仍有 4 次 `send_message` 被 **deny**（同原因码），说明该修复只覆盖「ask 路径」，**mandatory 规则本身仍会把未验证接收方判成需要审批**；在 `never` 下直接 deny。
- ask 总数 0，deny 6（1.8%）。
- **结论**：协调工具的「问」消失了，「拒」还在（4 次）；1.13.0 仍有 1 次 `team_task_create` 因档位被拒。

### v1.11.2（15:22–15:42，298 条）

- **`never` 下软性 ask 交给回退审查**（`1b972e9`）：ask 0、deny 2（0.7%）。
- 「27 次问了也没人答」的问题到此消失（全部 27 次发生在 11-14 22:38–11-15 00:56，即 1.9.0/1.9.1 窗口）。
- **结论（已修复）**：审批不可用时的「无意义 ask」被消除；但**非软性 ask（模型 high / 注入达线 / mandatory unknown）仍直接 deny**，这正是 1.13.0 的现场问题（§3.1）。

### v1.12.0（15:42–16:07，288 条）

- ask 0、deny 3、回退 14；出现 **20 480ms** 的单次授权（全量最大值），属于 primary 长尾 + 回退叠加。
- **结论**：拒绝率保持低位，但延迟上限没有跨阶段预算（最坏可到 ~60s）。

### v1.13.0（当前安装，16:07–17:21，417 条）

- **ask 0、deny 25（约 6%）**；`approvalPolicy=never`、`approvalAvailable=false`、`sandboxMode=danger-full-access` 占 100%。
- 拒绝构成（按原因 × mandatory × 工具）：

| 原因 | mandatory | 工具 | 次数 |
|---|---|---|---:|
| `model-material-risk` | unknown | pwsh | 10 |
| `model-material-risk` | safe | write | 3 |
| `model-material-risk` | safe | edit | 3 |
| `fallback-model-deny` | safe | edit | 3 |
| `tolerance=relaxed（严重度…）` | unknown | ask_user_question / pwsh / team_task_create / update_goal | 4 |
| `write-outside-authorized-workspace` | requires_approval | write | 1 |
| `model-injection-suspect` | safe | edit | 1 |

- **10/25 的拒绝落在插件自己判定 `mandatory=safe` 的 write/edit 上**：本地规则已认为在工作区内、有沙箱边界，但模型的 `medium/high` 意见把它升成 ask，`never` 下再变成 deny（`tolerance.js:405-417` 不对 safe 短路；`listener.js:237-263` 只在 softAsk 时回退）。
- **现场观测（17:09–17:18，非统计口径）**：本次审计的两个只读分析子代理被连续拒绝 14 次（`model-material-risk`，工具 pwsh/write/edit，其中 write/edit 的 mandatory=safe），重试后相同操作又能通过；其中 1 次 `write` 到 `%TEMP%` 被 `write-outside-authorized-workspace` 拒绝（属预期 fail-closed，但提示了「工作区外一律拒」）。
- 回退几乎不触发（4 次）：`automaticReview` 需要 `permissionPreset=auto` 或 `tolerance=autonomous`，当前配置 `tolerance=relaxed`，所以**没有第二模型兜底**，模型一票即拒。
- **结论（仍存在）**：1.13.0 从「问太多」转成「直接拒」，且拒的是本地已判安全的写操作；用户/代理看到的是工具报错而不是可批准的卡片。

### v1.14.0（17:14 发布，未安装）

- 无运行数据；本报告不覆盖。安装后再观察「统计审计修复」是否影响本结论（本次未见其代码路径参与授权裁决）。

---

## 3. 问题归纳（跨版本主题）

### 3.1 P0｜审批不可用时，模型风险直接变成硬拒绝（1.13.0 仍存在）

- 机制：`approvalPolicy=never` → `approvalAvailable=false`（`lib/guard/context.js:88-93`）；模型给出 ask 时，只有 `softAsk`（`mandatory!=unknown` 且 `choice!=high` 且注入未达线 且 `choice=medium` 或档位改过）才走回退，其余 `kind:"deny"`（`lib/guard/listener.js:237-263`）；回退失败也 deny（`lib/guard/fallback.js:133`）。
- 放大项：`tolerance` 对 `mandatory=safe` 不做短路（`lib/tolerance.js:405-417`），所以**本地已判定安全的 write/edit 仍会被模型意见升成 ask → deny**。
- 证据：1.13.0 的 25 次 deny 中 10 次 `mandatory=safe`；审计期间 14 次现场拒绝；1.9.0/1.9.1 的历史高拒绝率是同一机制的前身（当时更粗）。
- 影响：合法的文件修改被中止，代理进入重试；在 headless/自动审批环境（本机 `never`）没有人工兜底，等于「模型犹豫 = 任务失败」。

### 3.2 P0｜判定不稳定：同一操作「先拒后放」（全版本）

- 160 次拦截中 100 次（62.5%）在 120s 内重试同一工具，累计 533 次后续调用（`edit` 380 次）；
- 其中 **31 次在 120s 内被重新放行为 `defer_to_host`**（例如 `deny→edit` 7、`deny→pwsh` 7、`ask→edit` 11）；
- 说明裁决对措辞/上下文敏感，**不可稳定复现**；重试既浪费时间又制造「绕过」观感。

### 3.3 P1｜协调/只读工具被升级或拒绝（历史为主，当前仍有残留）

| 版本 | 现象 | 计数 | 现状 |
|---|---|---|---|
| 1.8.x–1.9 预览 | `send_message`/`team_task_*`/`list_agents` 被问 | 78 + 142 次 ask 中的大部分 | 1.11.1 后 ask=0 |
| 1.9.2–1.11.0 | `send_message` 接收方未验证 → ask/deny | ask 18/7/5，deny 13/…/4 | 1.11.1 修 ask；deny 残留 4 |
| 1.9.0–1.9.2 | 只读 MCP（blender get_*、siyuan system）被拒 | 8 次 | 1.9.2 后 0 |
| 1.13.0 | `team_task_create`/`update_goal` 因档位被拒 | 各 1 | 仍存在 |
| 1.13.0 | `edit` 因 `model-injection-suspect` 被拒（mandatory=safe） | 1 | 仍存在 |

根因：`effects.js` 白名单只覆盖少数工具；`mcp__*` 一律 `external_network + highImpact`；`internal_message` 需要「同树 + 可接续 + 下游独立审批」三者皆真才算 safe。对 Agent Teams 的协作工具，这等于常态性 unknown。

### 3.4 P1｜延迟与成本：回退模型是主要成本项（全版本）

- 回退占 v2 调用的 **21.9%（854/3 893）**；回退 p50 2 316ms、p90 4 618ms、p99 12 160ms、max 14 679ms；primary p50 仅 188ms。
- 1.9.2 窗口 p50 1.7s、1.10.0 p50 2.5s，都是回退主导；1.13.0 回退降到 4 次后 p50 回到 177ms。
- 代码上最坏可串行 ~60s：primary 重试（默认 1 次）+ 端点回退（404）+ 回退模型各带 20s 预算，且**没有跨阶段 deadline**（`lib/index.js:2065-2073,2096-2112`；`lib/guard/fallback.js:87-92`）。全量观测 max 20 480ms。
- 缓存命中 **0**：精确缓存键含「完整 state + questions」（`lib/index.js:1973-1979`），授权 state 又含参数哈希、参数预览与最近对话摘要（`lib/guard/listener.js:88,177,189`）；软缓存按安全评审要求对授权禁用（DEC-005）。因此授权每条都真打模型，属**设计后果**，不是故障；但它意味着「省 token」对授权点不成立。

### 3.5 P1｜观测口径（当前版本仍存在）

| 问题 | 证据 | 影响 |
|---|---|---|
| `reasonCode` 被写成中文长句 | 61 种取值；`tolerance=relaxed（严重度 0.680 ≥ 0.600…）` 54 条；1.13.0 仍有 4 条 deny | 机器聚合被拆碎、英文界面显示中文、跨版本对账困难 |
| 明细 observe 写拟执行动作 | `observe=>deny 74`、`observe=>ask 36`；页面无 mode 列 | 事后读日志会误判「观察模式拦了人」 |
| 两套 action 语义 | 遥测 `defer_to_host` vs 明细 `action.kind`；`outcomes.js` 矩阵没有 `defer_to_host` | 同一调用一边是「拦截」一边是「未裁决」；统计系统性偏差 |
| 遥测一次调用两条记录 | v2 3 893 次调用 → 7 779 条；按记录统计 ask/deny 翻倍 | 报表虚高 |
| `hostFinalAction` 从未回填 | 110 次 deny 全部 unknown | 「插件拒了但宿主本会放行」无法证伪，只能间接推断 |
| 审计自身写失败 | `auditWriteFailures>0` 234 条；7 次调用只落半条 | 少量丢数（<0.2%），但无告警 |
| 无版本字段 | 0/6 175 条记录带版本 | 本次只能按发布时间推断（§1.2） |
| `stats.jsonl` 的 `point=unknown` | 160 条（11-14 14:21–14:47，26 分钟窗口） | 统计页出现「未知」桶，授权率分母偏小；随版本修复，但读取端未兜底 |
| `.migrated` 备份 | 14.6 MB，与 logs 重叠 5 213/5 214 | 占空间；保留策略未覆盖 |
| `seq` 非唯一 | 233 个 `sessionId+seq` 重复键 | 用 seq 定位记录会错，须用 `id` |

### 3.6 正向结论（避免只报坏消息）

- **没有「插件拒绝但工具照常执行」的证据**：110 次 deny 的 `effectOutcome` 100% 为 `reported-error`；ask 被拒 27 次 → error，放行 23 次 → success，100% 对应。
- **本地快路径有效**：1 546 次 `local_policy` 决策不请求模型（延迟 0）；全量明细解析失败 0 行。
- **fail-closed 方向正确**：守卫二次校验只能收紧不能放宽（`lib/guard/listener.js:44-59`），未发现「模型/回退把宿主 deny 洗成 allow」的记录。
- **治理手段生效**：1.11.1 的接收方修复、1.11.2 的 never 回退、1.9.2 的 MCP 修复都在日志里可验证（对应 ask/deny 归零）。

---

## 4. 解决方案（按优先级）

> 每条给出「动作 → 代码位置 → 验收指标」。P0 针对 1.13.0 现场，P1 针对观测与成本，P2 针对治理。

### P0-1 让「本地已判安全」的写操作不再被模型一票否决

- **动作**：在 `never`/无审批通道且配置了回退时，把**非 soft 的 ask 也交给 `runFallback()`**；至少对 `mandatory.status === "safe"` 的 `write_workspace`（工作区内、sandbox 已约束）直接 `defer_to_host`，把最终边界留给宿主沙箱。仅当回退未配置/失败时才 deny。
- **位置**：`lib/guard/listener.js:237-263`（softAsk 分支）、`lib/tolerance.js:405-417`（safe 短路）。
- **验收**：1.13.0 现场 25 次 deny 中 10 次 `mandatory=safe` 归零；新增回归 `never + safe + model(high) → delegate/fallback`；不允许出现「safe 且 deny」。

### P0-2 抑制「先拒后放」与重试风暴

- **动作**：对 `(sessionId, tool, argsHash)` 建立短窗口（如 120s）判定记忆：同一调用重复到达时复用首次结论并标注 `reused=true`；同时在 deny 错误里返回「已审查过，请勿重试」的结构化原因，避免代理换措辞重试。
- **位置**：`lib/guard/listener.js` 入口（`exec.token`/argsSummary 已有）；`decision-cache.js` 可复用精确层。
- **验收**：拦截后 120s 内同工具重试率从 62.5% 降到 <20%；「先拒后放」从 31 次降到 0（同参同 session）。

### P0-3 `reasonCode` 稳定化

- **动作**：`guardOutcomeMessage` 兜底改为稳定枚举（如 `tolerance-note` / `tolerance-ask` / `tolerance-relaxed`），档位 note 只进 `humanReason`/`detail`；`tolerance.js` 不再把 note 塞进 `reason`。
- **位置**：`lib/guard/messages.js:52-66`、`lib/guard/listener.js:210,268`、`lib/tolerance.js:450/459/474`。
- **验收**：`reasonCode` 唯一值从 61 降到 <20；英文 UI 的 reason 列无中文；按 `reasonCode` 聚合的日趋势连续。

### P0-4 审计完整性：回填宿主最终动作 + 版本标记

- **动作**：`joinHostOutcome` 已有 `hostFinalAction` 参数但调用方从未提供（`lib/guard/audit.js:69-71,80-83`）；在 `tools/result` / guard 放行路径补 `hostFinalAction`（allow/deny/error）与 `pluginVersion`（+commit）字段，三处输出（明细/遥测/stats）统一。
- **验收**：`hostFinalAction=unknown` 占比从 100% 降到 <5%；每条记录 100% 带 `pluginVersion`；`auditWriteFailures` 从 234 降到 0 并告警。

### P1-1 回退成本与总预算

- **动作**：仅对 `mandatory=unknown`、primary failed、`external_network` 触发回退（当前条件偏宽）；给整次授权一个跨阶段 deadline（建议 10s 硬上限，回退扣减已用预算）；可对 primary/fallback 做 hedge（并发取先到者）。
- **位置**：`lib/guard/listener.js:229-234`、`lib/index.js:2065-2073,2096-2112`、`lib/guard/fallback.js:87-92`。
- **验收**：回退触发率从 21.9% 降到 <10%；授权 p99 从 7.3s 降到 <2s；最坏耗时 <10s。

### P1-2 统一两套日志口径

- **动作**：遥测补 `mode` 与 `effectiveAction`（或 `enforced:boolean`）；明细 observe 写 `wouldAction`；`outcomes.js` 矩阵加入 `defer_to_host` 的明确桶；遥测一条调用只保留一条（或加 `phase` 并在读取端按 `call_id` 去重）。
- **验收**：同一调用的明细/遥测/统计三处 action 可一一对应；报表 ask/deny 不再翻倍；页面能区分 observe 与 enforce。

### P1-3 缓存：要么明确禁用，要么做可用白名单

- **动作**：保留「授权禁用软缓存」的安全结论（DEC-005），但在配置页/统计页明示「授权不适用缓存」；若要省 token，另建**显式**白名单缓存：键 `(tool, argsHash, contextVersion, questionsVersion)`，仅 `read_local` 与 `mandatory=safe` 的写操作，TTL ≤ 10min，命中需可撤销。
- **验收**：命中率可测且仅限白名单；未白名单调用命中率保持 0；不得出现「参数不同却复用」。

### P1-4 协调工具与 MCP 只读分级

- **动作**：`send_message/team_task_*/wait_agent/list_subagent_models` 在 `effects.js` 里按「宿主已强制」判 `internal_state`/`internal_message`（保留 recipient 校验，但不要 highImpact）；`mcp__*` 按工具注解/名称（`get_*`、`list_*`）降级为 unknown 低风险，至少不因「MCP」本身判 high。
- **验收**：协调类工具 ask/deny 从历史 100+ 次降到 0（1.13.0 仅 1 条 `team_task_create`）；只读 MCP 不再被拒。

### P2-1 数据治理

- **动作**：迁移完成后删除/归档 `.migrated`（14.6MB）；给 `telemetry.jsonl` 加保留策略（当前 28MB 无上限）；统一 `logs/`、`telemetry`、`stats` 的保留与配额，并在配置页展示占用。
- **验收**：`~/.dsh/dsh-decision-engine` 总占用可解释；备份不与主数据重复。

### P2-2 统计读取端兜底

- **动作**：`stats-store`/页面把缺 `point` 的记录归入显式 `unknown` 桶并标注版本窗口，不进入授权率分母；读取端按 `call_id` 去重。
- **验收**：统计页「unknown」不再静默污染；1.9.2 前窗口在图表上可区分。

---

## 5. 复现与证据

```powershell
# 1) 版本发布时间（直接证据）
npm view @leonhardthust/dsh-decision-engine time --json

# 2) 本机安装版本与时间
Get-Content "$HOME\.dsh\profiles\desktop\package.json" | Select-String 'decision-engine'
(Get-Item "$HOME\.dsh\profiles\desktop\package.json").LastWriteTime

# 3) 明细聚合（本报告 §1–§2 数字）
node tmp-audit/agg.mjs  > tmp-audit/agg.json
node tmp-audit/deep.mjs > tmp-audit/deep.json
node tmp-audit/versions2.mjs > tmp-audit/versions2.json

# 4) 遥测对照（§3.1/§3.4/§3.5）
node tmp-audit/analyze-telemetry.mjs "$HOME\.dsh\dsh-decision-engine\telemetry.jsonl" 13556 > tmp-audit/analysis-output.txt
```

- 代码级根因与行号：`tmp-audit/findings-code.md`
- 遥测宿主结果对照：`tmp-audit/findings-telemetry.md`
- 明细原始数据：`~/.dsh/dsh-decision-engine/logs/*.log`

---

## 6. 局限与未验证

1. **版本边界是推断**：日志无版本字段；发布/安装时间只能给出窗口，窗口内的本地构建（如 11-14 16:41 的 schema 断点）无法精确归属。要根治，先加 `pluginVersion`（P0-4）。
2. **配置与版本混淆**：1.9.2 后大量窗口是 observe 或 `never`，拒绝率变化同时受「版本修复」与「配置切换」影响；本报告只在同一窗口内比较，跨窗口只作趋势。
3. **没有人工 ground truth**：无法判定某次拒绝「本应放行」，只能给出「mandatory 已判 safe 却被拒」「同参重试又通过」「只读工具被拒」等强间接证据。
4. **`hostFinalAction` 缺失**：无法直接证明「宿主本会允许」；`effectOutcome=reported-error` 也无法区分「插件拦截」与「工具自身报错」（对 deny 语义影响很小）。
5. **遥测在 telemetryLevel=off 期间不写**：0 条不代表 0 次拦截。
6. **数据持续增长**：本报告数字为 17:06–17:21 快照；明细与遥测仍在追加，比例会小幅漂移。
7. **未覆盖**：11-12 的早期记录只在 `stats.jsonl` 中留有统计（明细已迁移为 `.migrated`）；`goal_summary`/`args_summary` 仅存 sha256，无法还原参数内容（隐私设计预期）。
