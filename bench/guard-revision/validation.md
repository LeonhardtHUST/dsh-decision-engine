# 验证执行记录

## 环境与证据边界

- Windows x64，`vp v1.6.0`，Node.js `v26.13.1`，pnpm `10.32.1`。
- 基线为 `ff758465166184455d566f851841308bdc682fb4`，开始时没有未提交改动。
- 验证仅在临时 fixture 与仓库开发依赖中进行；未安装当前 profile、未修改全局权限、未执行生产删除 / 外传 / 提权。
- 真实 GUI 返回 authentication required；源码 UX 复核不能替代安装后明暗主题与字体实测。

## 已完成检查点

| 检查 | 命令 | 已观察结果 |
| --- | --- | --- |
| 原生测试基线（安装 peer 依赖后） | `vp run test` | 726 项，706 通过，20 失败 |
| 安全核心与原容忍度 | `vp node --test`，guard-context/policy/audit/advisory/calibration + tolerance 系列 | 75 / 75 通过 |
| 安全接线检查点 | guard + scope + tolerance + 显示原因系列 | 135 / 135 通过 |
| 加入配置 API 与异常回退后的安全检查点 | 同上并包含 guard-config-route | 139 / 139 通过 |
| 精确审批与例外路径跟进 | scope + guard-wiring + guard-config-route | 32 / 32 通过 |
| 模拟场景 | `vp run verify:guard` | 24 独立情景 × 4 档，96 / 96 匹配预先声明的策略期望 |
| 接线与 Config schema | `vp run verify:wiring` | 全部检查通过（本地依赖，非真实 Host E2E） |
| 提交规则正例 | Angular 格式、包含简体中文的 subject | 通过，实际提交 hook 已执行 |
| 提交规则反例 | 不含汉字的 subject | commitlint 明确拒绝 |

基线失败包括 Windows POSIX mode 断言、中文系统下未固定 navigator 的语言假设、测试目录路径分隔符、provider 后台时序等。与本次有关的旧容忍度 fixture 与前端结构断言已按新契约修订；不把所有基线失败都解释为安全代码回归。

## 场景口径

- `gold.json` 明确列出 8 良性 / 8 高影响 / 8 来源权限对照的预期，包含自治档将软性注入嫌疑交模型复核的预期差异。
- `old-new.jsonl` 每行保留档位、旧纯函数反事实、新插件动作、mandatory 原因分支、决策模型 / 回退模型调用数和 fixture dispatch 次数。
- `report.json` 给出 FULL / CD / NR 以及每档合成 FPR / 合成高影响放行率；FULL 仅指受控 fixture 中输入可见，不是对真实执行副作用的充分观测。
- 合成 benign FPR=0/8，各档合成高影响放行=0/8。样本少且使用模型 stub，不能外推为生产零误杀 / 零漏杀，也不能用作概率校准。
- 真实危险 FNR=N/A：真实工具名进入了审核管线，但高危生产工具 executor 没有被调用。
- 历史 240 条 shadow 与 12 条现场录制未提供；没有 `_bench/gatebench-out`，所以旧现场回归、matched FULL 历史改进与实际收益无法验证。

## UX 源码复核

独立 UX 复核发现并要求处理：输入逐字符重拉目录、补档位失败清空目录、模型失败关闭未披露、主开关关闭时三态仍造成保护错觉、输入与选择缺少可访问名称、浅色模式固定白字风险。字体顺序核对为 `Sarasa Gothic SC → system-ui → sans-serif`。用户随后补充决策历史卡片页也需要修复，已把表格、展开明细、空态和错误状态列入同样的字体与字号检查范围，保留滚动与排序契约。最终交付以仓库测试与代码为准，不将源码推算的对比度当成实测。

## 最终全量结果

最终 `vp run test`：**802 项，797 通过，5 失败，0 skip**。源码已包含设置页、决策历史字体字号与冷却诊断 fixture 修订。

- `config-rename`：Windows 返回 mode 0666，旧断言要求 0600。
- `decision-store`：同样的 Windows POSIX mode 断言失败，不能据此宣称 Windows ACL 已验证。
- `telemetry`：旧测试以 POSIX group/other mode 验证权限，Windows 不满足该断言。
- `stats`：旧失败路径 fixture 在 Windows 没有制造出预期写盘失败。
- `server-provider-route`：清理阶段 `ENOTEMPTY`，后台写入与同步删除临时目录竞态。

以上对应基线已有失败类别，未通过跳过测试或放宽生产安全策略消除。新增安全策略、配置 API、UI 行为和排版测试均通过。此前冷却诊断测试因缺少宿主可信写范围，无法再进入模型路径；已补显式授权 fixture，原诊断断言保持并通过。

合并 UI 专测：**186 / 186 通过**，包含设置行为、i18n、词表覆盖、决策历史排版及图表 sanity。安全专测：**139 / 139 通过**。`verify:wiring`、`verify:guard`、全阶段 commitlint 与 `git diff --check` 通过。

原始输出保留于本目录 `full-tests.txt`、`ui-tests.txt`、`security-tests.txt`、`wiring-tests.txt`、`scenario-tests.txt`；机器对照仍在 `old-new.jsonl` / `report.json`。未安装进运行 profile，未修改全局 DSH 配置，未推送远端。
