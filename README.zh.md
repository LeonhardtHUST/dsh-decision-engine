# dsh-decision-engine

本分支发布包：**`@leonhardthust/dsh-decision-engine`**，基于 [zuosus 上游](https://github.com/zuosus/dsh-decision-engine) 的 MIT 代码。不要同时启用原包与本分支；安装与发布方法见 [发布说明](docs/releasing.md)。

![dsh-decision-engine — DeepSeek Harness 决策引擎](docs/assets/hero.jpeg)

**提供免费决策模型**

[网站](https://dsh.zuos.us/dsh-decision-engine/) ·
[config.example.yml](config.example.yml) · [DECISIONS.md](DECISIONS.md)

[English](./README.md)

给 DeepSeek Harness 的决策层：主模型动手之前，用一个便宜的决策小模型做结构化判断。

## 功能

**八个决策点**

- 工具授权
- 模型路由
- 子任务分派
- 上下文压缩
- 轮次延续
- 检索必要性
- 技能选择
- 思维链翻译

**三态**：关闭 · 观察 · 生效

**决策服务**：system one · bamboonode · 硅基流动 SiliconFlow（国内 / 国际）·
阿里云百炼 · TokenHub · Perplexity · OpenRouter · 自定义 base URL

**安全档位（询问频率）**：不问 · 少问 · 默认 · 多问（四档都不改变权限强制的人工批准与拒绝）

**界面**：配置页（四个可折叠分组）· 决策历史标签页 · 统计与对比 ·
审批卡正文可读化 · 决策日志分文件（按日期 / 会话 / 工作区）与自动清理

| 配置页 | 决策历史 |
|---|---|
| ![配置页](docs/assets/config-page.png) | ![决策历史](docs/assets/decisions-tab.png) |

> 截图拍于分组折叠（DEC-051）之前的版式，当前界面为四个可折叠分组。

**省 token**：精确缓存 · 只读工具放行 · state 截断

**安全分层**：可信宿主上下文 → 工具副作用 → 强制权限策略 → 模型建议 → 软审核容忍度 → 宿主结果审计。
未知高影响操作不再异常放行；自动审查保留决策模型，并将软性“人工决定”交给所选 Fallback。

**自动审查 Fallback**：指定宿主模型（含 reasoning effort）· 沿用会话模型 · 全部允许 · 全部阻止。
“全部允许”只影响软审查，不能覆盖强制拒绝或必需的真人批准。

详见 [安全修订与验证说明](docs/security-revision.md)。默认仍未启用插件，观察模式不提供拦截保护。

## 许可证

MIT
