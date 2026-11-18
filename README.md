# dsh-decision-engine

面向 DeepSeek Harness 的决策层插件。主模型调用工具、路由模型、分派任务或继续轮次前，插件可以先调用一个决策模型做结构化判断。

本仓库发布的 npm 包是 `@leonhardthust/dsh-decision-engine`，基于 [zuosus/dsh-decision-engine](https://github.com/zuosus/dsh-decision-engine) 的 MIT 代码。不要同时启用上游原包和本分支。

## Quick Start（快速开始）

### 1. 安装

在 DeepSeek Harness 的插件管理器中安装：

```text
@leonhardthust/dsh-decision-engine
```

也可以指定版本：

```text
@leonhardthust/dsh-decision-engine@1.17.0
```

### 2. 启用并配置

1. 在插件管理器中启用插件。
2. 打开插件配置页，选择决策服务并填写对应的 API Key。
3. 先使用 `observe` 观察决策记录，确认结果符合预期后，再把需要拦截的决策点改为 `enforce`。
4. 保存配置并重新开始一次会话。

插件默认不启用拦截。`observe` 只记录判断，不提供拦截保护。

### 3. 第一次使用

完成配置后直接发起普通对话，插件会在已启用的决策点记录判断结果。可在 **决策历史** 和 **统计与对比** 页面查看记录、缓存命中和决策结果。

建议先启用一个决策点验证：

- `authorize`：工具授权
- `route`：模型路由
- `delegate`：子任务分派
- `compact`：上下文压缩
- `turnStop`：是否继续下一轮
- `retrieval`：是否需要检索
- `skillPick`：技能选择
- `cotTranslate`：思维链翻译

## 主要功能

- 八个可独立开关的决策点。
- 三种运行模式：`off`、`observe`、`enforce`。
- 精确缓存、只读工具快速放行和状态裁剪，减少重复决策请求。
- 决策历史、统计信息、可读的审批卡正文，以及按日期、会话或工作区拆分的日志。
- 安全档位：不问、少问、默认、多问。档位只影响软性审查频率，不会代替权限强制的人工批准或拒绝。
- 支持 system one、bamboonode、硅基流动（国内 / 国际）、阿里云百炼、TokenHub、Perplexity、OpenRouter 和自定义 Base URL。

## 安全边界

安全判断按以下顺序处理：

1. 读取可信的宿主上下文。
2. 识别工具副作用和目标范围。
3. 先执行强制权限策略。
4. 再调用决策模型做软性审查。
5. 根据安全档位处理软性询问。
6. 记录宿主最终审批和执行结果。

未知的高影响操作默认保持拒绝或继续审批。模型裁决和回退策略都不能覆盖强制权限约束。

工作区或临时目录中的单文件删除只有在宿主确认执行目录、命令形状、目标路径和沙箱边界后，才会交给宿主沙箱执行。路径、目标数量、命令参数或宿主证据不明确时，仍需审批。

同树中可接续的子代理消息会在宿主 guard 注册后直接交给宿主处理。树外、一次性、诊断或无法核验的目标仍需审批。

## 隐私

本分支不再生成匿名安装 ID、安装事件或每日心跳，也不读取或更新旧的 `analytics.json`。决策历史和统计保存在本地。插件只会向你配置的决策服务发送请求。

## 配置与文档

- [配置示例](config.example.yml)
- [发布与安装说明](docs/releasing.md)
- [安全修订与验证说明](docs/security-revision.md)
- [项目决策记录](DECISIONS.md)

## 开发与验证

```powershell
vp install --frozen-lockfile
vp run verify
vp run verify:guard
```

## 许可证

MIT
