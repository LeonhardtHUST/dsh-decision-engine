# 2026-11-16 审批日志审计：可落地的代码结构优化

> 数据：`~/.dsh/dsh-decision-engine/logs/2026-11-16.log` + `2026-11-16.1.log`（当天轮转）
> 快照：2026-11-16 22:40（数据仍在追加），约 **5 820 条 authorize 记录、62 个会话**，两个文件合计约 13 MB
> 方法：日志分布 + 代码交叉验证；独立审查过一轮，数字按 22:40 复核。只读分析，未改源码。

## 0. 结论

今天没有出现明显的误拒：68 次 ask 在遥测里能回填结果的**全部是 `allowed-once`**（用户批准），41 次 deny 全部 `reported-error`；deny 的大头（23 次）是 `approval-policy-never`（会话没有审批通道），其余是 destructive / write-outside / host-tool-access 等真实约束。

真正值得动的结构问题，按收益排序：

| 优先级 | 结构问题 | 今日证据 | 预期收益 |
|---|---|---|---|
| P0 | 判定归一化只发生在 `finish()`，短窗记忆在它之前落库 | 9 条 `reused` 记录全部写成 `local_policy` + `modelEvaluation=not_requested`；4 条 `reasonCode=unclassified` | 审计不再说谎；复用可追踪 |
| P1 | shell 没有只读契约，所有 `pwsh` 都过一次模型 | **1 851 次调用、2.28M tokens（模型 token 的 59%）**，其中 1 593 次判低风险 | 最大单项成本来源，见 §3 P1-1 |
| P1 | `never` 模式下仍审查 `mandatory=safe` 的工作区写 | 约 870 次调用、1.16M tokens（31%）；模型结论 `ask` 会被改写为放行（46 条），失败反而拒绝 | 纯开销；可安全跳过 |
| P1 | 未契约的内部/生命周期工具 | 257 次调用、322k tokens；`job_kill` 被回退拒 4 次，`ask_user_question` 被拒 1 次 | 省 ~9% 调用，修功能失败 |
| P1 | 没有跨阶段 deadline | 42 次模型调用 >10 s，max 21.3 s；3 次 network-error 在 20.7–21.3 s 后转 deny | 尾延迟封顶 |
| P2 | 记录组装三份，本地判定写全量骨架 | 本地 2 882 条占授权日志 40.3%；无 `pluginVersion` | 日志约降 40%，可按版本聚合 |
| P2 | `listener.js` 单函数 317 行 | P0 的 bug 正是「记忆路径绕过 finish」造成 | 阶段可单测 |

---

## 1. 今日分布

### 1.1 裁决与工具

| 维度 | 值 |
|---|---|
| authorize 记录 | 约 5 820（62 会话，12:26–22:40，全部 `enforce`） |
| action | delegate 5 702（98.1%）、ask 68（1.2%）、deny 41（0.7%） |
| 模型调用 | 2 933 次（50.5%），3.70M input tokens，均值约 1.26k |
| 纯本地判定 | 约 2 882 次（0 token，0 ms） |
| 审批通道 | `never/false` 5 638 次（97%）；`ask/true` 172 次（workspace-write 会话） |

| tool | ask | deny | 主要原因 |
|---|---:|---:|---|
| edit | 39 | 3 | `privilege-change-requires-approval`（38 次 approved） |
| pwsh | 21 | 17 | `privilege-change` / `approval-policy-never` / destructive |
| write | 5 | 8 | `privilege-change` / `write-outside-authorized-workspace` |
| 其余 | 3 | 13 | host-tool-access-denied、`job_kill` 回退拒绝等 |

### 1.2 四个现象

1. **53 次 sandbox 提权审批全部被批准**（edit 38、pwsh 15、write 4，遥测 `allowed-once`）。它们来自 `workspace-write` 会话对工作区外文件的修改；一次真实任务产生几十张审批卡，这是宿主「按次审批」的固有成本，不是插件误判。
2. **shell 是最大的模型成本**：`pwsh` 模型调用 1 851 次、2 284 212 tokens，占模型 token 的 **59.0%**，其中 1 593 次结论是低风险。`effects.js:99-111` 只对 sudo/destructive/network 做正则，其余命令全部 `unknown`。
3. **`never` 模式下安全写仍逐条问模型**：`edit`/`write` 且 `mandatory=safe` 的模型调用约 870 次、1.16M tokens（31%），其中约 800 次是低风险。结论是 ask 时也会被 `safe-local-operation-host-sandbox` 改成放行（今天 46 条），模型失败时反而会拒绝（`listener.js:268-269`）。
4. **未契约工具占掉 257 次调用**（322k tokens）：`team_task_create` 90、`wait_agent` 54、`plugin_manager` 27、`subagent_*` 40、`undo_*` 14、`job_kill` 10、`update_goal` 6、`present` 4、`create_goal` 4、`interrupt_agent` 4 等。其中 `job_kill` 被回退模型拒绝 4 次，`ask_user_question` 被拒 1 次（代理连向用户提问的通道都被挡了）。

### 1.3 延迟

模型调用延迟：p50 204 ms、p90 413 ms、p99 **10 794 ms**、max **21 345 ms**；>3 s 62 次，>10 s 42 次。
3 次 `network-error` 分别在 21.3/21.2/20.7 s 后落成 `advisory-failed-unknown-effect` → deny。

---

## 2. 结构问题与证据

### 2.1 判定归一化发生在记忆之后（P0）

**现象**：9 条 `reused:true` 记录全部 `decisionSource=local_policy`、`modelEvaluation=not_requested`；其中 4 条 `reasonCode=unclassified`，5 条 `tolerance-delegate`（后者自带 reasonCode，所以没落哨兵）。8 条是 `wait_agent` 同参数轮询，1 条 `update_goal`，原始裁决都是 34–120 秒前的 `primary_model`。

**代码链路**：

- `listener.js:205-212`：命中记忆后直接 `finish({kind, reason, reasonCode: memoized.reasonCode, humanReason, reused:true})`。
- `listener.js:295-306`：写记忆时存的是**归一化之前**的 `action`；`reasonCode` 缺失就填 `"unclassified"`。
- `finish`（`:123-179`）才是唯一做归一化的地方；记忆路径上 `decisionSource` 仍是初始 `local_policy`（`:106`），`primary`/`secondary` 仍是空闲态（`:104-105`），于是 `modelEvaluation` 写成 `not_requested`（`:129-130`）。
- `messages.js:15` 把 `unclassified` 也放进了 `MESSAGES`；`:67` 的 explicit 判断因此把它当「显式稳定码」原样返回，不再走本地化。于是 `detail` 留下枚举码 `model-low-risk-advisory`，而不是人类文案。

**影响**：审计里看是「本地规则放行、没调模型」，实际是模型裁决的复用；按 `decisionSource` 统计模型覆盖率会漏 9 条，按 `reasonCode` 聚合多一个无意义桶。

### 2.2 shell 没有只读契约（P1，最大成本）

`effects.js:99-111` 对 `pwsh/bash/shell` 只匹配三类正则（提权、删除/重置、外网），其余一律 `unknown/highImpact`。后果是**每条普通命令都要过一次模型**：今天 1 851 次、2.28M tokens，而其中 86% 的结论是低风险。

这不是让模型变准就能解决的问题：模型只能回 ask/delegate（`advisory.js:100-109`），面对 `Get-ChildItem`、`git status` 这类命令，它永远给不出比「低风险」更多的信息。结构上缺的是**只读命令族的闭集契约**，不是更好的提示词。

### 2.3 `never` 模式下安全写的模型审查是纯开销（P1）

`mandatory=safe` 的 `write_workspace` 在 `approvalAvailable=false` 时：

- 模型返回 `ask` → `listener.js:286-287` 改 `delegate`（今天 46 条）；
- 模型返回 `delegate` → 仍 `delegate`；
- 模型失败/超时 → `:268-269` 直接 `deny`。

也就是说，在今天全部 `automatic=false` 的会话里，**模型既不能阻止、也不能批准，只能制造失败**。约 870 次调用、1.16M tokens 没有改变任何结果，却贡献了「网络抖动 → 合法写被拒」的风险。`advisory.js:100-109` 可以确认模型不会返回 deny，这个判断不依赖具体模型；但若 `automaticReview` 为真（preset=auto 或 tolerance=autonomous），ask 会进回退审查，回退是有可能拒绝的，不能跳过。

### 2.4 三条记录旁路 + 本地记录全量骨架（P2）

同一次授权在 `finish()` 里组装三遍：`createGuardAudit()`（`audit.js:29-75`）、`trace`（`listener.js:141`）、`scores`（`:150-157`）。字段靠手工同步，已经漂移：`reused` 只在 `scores`/`trace`，`modelEvaluation` 被 `dedup` 折叠。

纯本地判定约 2 882 条，仍写完整 `scores` 骨架、空的 `questions`、`content.state`，约 4.91 MB——占授权日志的 40.3%、全部日志的 37.6%。这些记录没有任何模型信息。

记录里仍然**没有 `pluginVersion`**（`decision-store.js:310` 只有 `v:1`）。本次审计又只能靠发布时间和 schema 断点推断版本。

### 2.5 没有跨阶段 deadline（P1）

`index.js:2005` 的总预算 `min(2×20, 30)` 秒，但 `resilience.js:97-99` 只在失败后检查；每次尝试有独立的 20 秒计时（`:2036`）。所以主模型最坏约 40 秒；回退模型再给 20 秒（`fallback.js:87-92`），合计约 60 秒。

今天全部会话 `automatic=false`，主模型失败直接拒绝（`:268-269`），观察到的是约 21 秒。但非自动模式也能走到 60 秒：主模型第二发返回 ask，审批策略是 never 且不是 safe，就会走 `:288` 回退；今天已有 2 次 `fallback-review-failed`（一次回退 20.0 秒超时、一次 13.0 秒）导致 `pwsh` 被拒。

### 2.6 `listener.js` 单函数 317 行（P2）

11 个可变局部量、3 个闭包（`runFallback`/`finish`/listener），依次做：读配置 → 建上下文 → 分类 → 强制策略 → 记忆 → 模型 → 档位 → 回退 → 归一化 → 审计 → 返回。P0 的 bug 就是阶段边界不可见的直接结果：记忆分支没有赋值 `primary`，`finish` 却按「没调模型」记录。

### 2.7 `sandbox_permissions` 只看「有没有」（P2，先补观测）

`effects.js:24-26` 只要参数里出现 `sandbox_permissions` 就判 `privileged`，不比较请求级别与当前级别。今天 57 次 privilege ask + 23 次 never deny 基本都来自这里，其中 53 次用户批准。日志没有 `requestedSandbox`，无法回答「多少次是同级别空转」。

---

## 3. 建议的改动（按顺序）

### P0-1 归一化提前，记忆存归一化后的 verdict

- 新增 `normalizeVerdict(rawAction, mandatory, context)`：返回 `{kind, reasonCode, reason, humanReason, displayReason, source}`。
- 写记忆时存 `guardOutcomeMessage(action, mandatory)` 之后的对象，并附 `decisionSource` 与 `modelEvaluation`；命中时把 `reused:true`、`decisionSource:"memo"`（或保留原来源 + `reusedOf`）带进记录。`"memo"` 与 `reusedOf` 二选一，不要同时存在两套口径。
- `messages.js`：把 `unclassified` 的文案挪到单独常量（`messages.js:77` 直接引用 `MESSAGES.unclassified[0]`，删词条会抛 TypeError）；`guardOutcomeMessage` 遇到未知码统一落 `unclassified`，原文进 `humanReason`。
- 验收：复用记录的 `reasonCode` 与原始记录一致；`decisionSource`/`modelEvaluation` 反映真实来源；真正未知的原因仍可落 `unclassified`（不是「unclassified 必须为 0」）。

### P1-1 shell 只读命令族闭集契约

- 在 `effects.js` 增加一个**严格 argv 解析**的只读子集：命令名在闭集内、参数形状匹配、无重定向/管道/命令替换/`Invoke-Expression`、无写路径，才返回 `read_local`；任何一条不满足就退回 `unknown`。
- 起步闭集只放最保守的几族：`git status/diff/log/show`（不含 `--output`）、`Get-ChildItem`/`Get-Content`/`Test-Path`、`rg`、`Get-Process`、`Get-Command`。不把 `node -e`、`pnpm test`、`npm run` 这类「执行任意代码」的命令放进去。
- 先用日志统计需求：`decision-cache.js` 已有 `commandFamily()`，在 `effect.evidence` 里记录 family（不记录原始命令），一周后按 family 分布决定扩哪些族。
- 验收：`pwsh` 模型调用从 1 851 次/日降到 <1 000；未被覆盖的命令仍 100% 过模型；新增命令族必须有反例测试（重定向、管道、子命令拼接）。

### P1-2 `never` 模式下跳过安全写的模型审查

- 条件收紧为：`approvalAvailable === false` 且 `automaticReview === false` 且 `mandatory.status === "safe"` 且 `effect.kind === "write_workspace"` 且 `effect.canonical === "inside"`。命中时直接 `delegate`，reasonCode 复用 `safe-local-operation-host-sandbox`。
- 不动有审批通道的会话（`ask/true`），那里模型 ask 仍会弹卡；也不动 `unknown`/`requires_approval`。
- 验收：约 870 次调用、1.16M tokens/日归零；安全写不再因网络失败被拒；宿主沙箱仍是最终边界（记录里保留 `hostEnforced`）。

### P1-3 内部/生命周期工具契约

- `effects.js` 改为表驱动：`{schema, effect, recoverability, hostEnforced}`，参数形状与分类写在同一处。
- 优先补：`team_task_create`（internal_state，宿主 revisioned）、`wait_agent`（internal_state 轮询）、`ask_user_question`（internal_state，不能挡用户通道）、`update_goal`/`create_goal`（internal_state）、`interrupt_agent`（internal_state 生命周期）、`job_kill`（内部状态；至少不应被回退一票否决）、`undo_list/diff/message_list`（read_local）、`undo_snapshot/restore`（写配置，按 privileged 或 internal 明确归类，不留在 unknown）。
- `plugin_manager`、`present` 有真实副作用（装插件、发布文件），保持模型复核或归入 privileged，不要简单放行。
- 验收：未契约的内部/unknown 调用从 257 次/日降到 <100；`job_kill`、`ask_user_question` 的 deny 归零；每个契约一条测试。

### P1-4 授权 deadline

- 新增 `authorizeDeadlineMs`（建议 8–10 s，从进入 listener 起算），primary 与 fallback 共享预算。超时按确定规则收尾：`mandatory=safe` → delegate；`unknown` → deny + `reasonCode=review-timeout`；`requires_approval` 不经过模型，不受影响。
- 验收：authorize p99 < 2 s、max < deadline + 1 s；超时记录带 `timedOut:true`，不再伪装成 `advisory-failed-unknown-effect`。

### P2-1 记录只组装一次 + `pluginVersion`

- 用一个 `buildDecisionRecord(audit)` 生成明细与遥测共用结构，`scores` 从 `trace` 派生；纯本地记录写精简形态（省略 `modelEvaluation`/`questions`/空 `scores`），读取端 `expandRecord()` 已有默认值。
- 顶层加 `pluginVersion`（读 `package.json` 一次，启动缓存）与 `schemaVersion`。
- 验收：日志体积降 ≥35%；任意记录可读出运行版本；`scores` 与 `content.state` 的 `reasonCode`/`decisionSource` 一致（加一致性断言）。

### P2-2 listener 拆阶段

- 拆出 `classifyStage` / `mandatoryStage` / `memoStage` / `modelStage` / `toleranceStage` / `fallbackStage` / `verdictStage`，每个接收上一阶段输出、返回新对象；`mountGuard` 只编排与副作用。
- 验收：每阶段可独立单测；`listener.js` < 180 行；P0-1 的回归用例落在 `verdictStage`。

### P2-3 提权分类补观测（先不改行为）

- 在 `effect.evidence` 记录 `requestedSandbox` 与 `currentSandbox`；只有请求级别更宽时才 `privileged`。先用一周日志统计「同级别空转」次数，若为 0 就只保留观测字段。

---

## 4. 不建议做的

- **不要用软缓存复用授权裁决**（DEC-005）：今天 `edit` 的模型调用参数各不相同，软键会重演「不同文件继承放行」。
- **不要为了省调用把 `pwsh` 整体放行**：只放闭集内的只读命令族，其余保持模型复核。
- **不要在有审批通道的会话里跳过安全写审查**：那里模型 ask 仍会生成审批卡，是有意义的人工确认。
- **不要把人类文案塞进 `reasonCode`**：聚合字段必须是封闭枚举，文案放 `humanReason`/`displayReason`。

---

## 5. 复现

```powershell
node tmp-audit/final.mjs      # 今日总量、模型调用、token、延迟
node tmp-audit/rev.mjs        # pwsh/edit/write 的调用与 token 占比
node tmp-audit/meta.mjs       # 复用记录与渠道分布
node tmp-audit/unc.mjs        # 一条 reused/unclassified 原始记录
node tmp-audit/unc2.mjs       # 未契约工具分布
node tmp-audit/jk.mjs         # job_kill 的 10 次裁决
```

代码位置：`lib/guard/listener.js:123-179,205-212,295-306`、`lib/guard/messages.js:15,62-80`、`lib/guard/effects.js:16-118`、`lib/guard/advisory.js:100-109`、`lib/index.js:1997-2012`、`lib/decision-store.js:310`。

---

## 6. 局限

1. 日志仍在追加，数字为 22:40 快照（独立复核时 5 819 条）；比例可能有 ±1% 漂移。
2. 决策明细只存参数哈希，无法还原 `sandbox_permissions` 的具体级别，§2.7 只能先补字段。
3. 遥测在 `telemetryLevel=off` 期间不写，ask 的宿主结果只在有遥测的时段可回填。
4. 没有人工 ground truth：本报告只判断「结构是否让审计与行为一致」，不判断单次裁决对错。
