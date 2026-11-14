# 仓库协作约束

## 子代理模型与推理档位

- 禁止使用 `sol` 的 `high` 推理档位运行子代理。
- 重难点任务使用 `sol medium` 或 `deepseek-flash high`。
- 小问题使用 `deepseek-flash low`。
- 创建子代理前查询可用模型路由，显式设置 provider、model 和 reasoning_effort；不依赖可能为 `sol high` 的默认值。
- 若指定路由不可用，先报告限制，不得静默提升为 `sol high`。

## 开发与提交

- 使用 Vite+ (`vp`) 管理仓库依赖和任务；现有 Node.js 测试通过 `vp run test` 执行，不擅自迁移测试框架。
- 按可审查阶段及时自动提交，不积压无关更改；不得自动推送远端。
- 提交遵循 Angular commit convention，提交说明使用简体中文且必须包含汉字。
- commitlint 通过仓库的 Vite+ commit-msg hook 校验提交格式与汉字约束。
- 多代理共享文件系统时按不重叠文件范围分工，提交前审查 diff 并运行相关测试。
- 安全测试仅使用隔离 fixture 和虚构资源，不触发生产环境高危副作用。
- 不得擅自修改本机全局 DSH 配置。
