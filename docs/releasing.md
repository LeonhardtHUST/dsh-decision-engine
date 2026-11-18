# npm 发布

发布目标：`@leonhardthust/dsh-decision-engine`，当前版本 `1.17.0`，公开包。

本分支基于 `zuosus/dsh-decision-engine` 的 MIT 代码，保留原作者与许可证；npm scope、源码仓库、bundle 引用和浏览器主模块 / charts chunk 标识已同步为本分支身份。内部 API、样式标识和用户数据目录保留旧名称以兼容已有配置。不要同时启用原包与本 scoped fork，它们提供相同的服务与页面。

## 工作流

- `.github/workflows/ci.yml`：main push、PR、手动运行或发布工作流复用；Ubuntu 24.04 + Node.js 24 + Vite+ 1.6.0。执行 frozen install、完整测试与接线、隔离情景、实际打包和 tarball 检查。失败不会被忽略。
- `.github/workflows/publish.yml`：每次 `main` push 自动检测版本。先比较整个 push 的 `before` 与当前 manifest，拒绝错误包名、非法或倒退版本；再只读查询 npmjs。当前版本已上传则跳过；当前版本高于 npmjs latest 且未上传则进入完整验证及发布。多提交 push 比较整个 push 前后，不仅比较 HEAD 的父提交。
- 后续发版只需修改 `package.json` 版本并提交到 main；无需创建 tag 或手动点运行。发布依赖检测和本次提交的完整 CI 均成功，不跳过测试。稳定版本发布到 `latest`，预发布版本自动进入 `next`。
- `1.17.0` 放宽危险操作的工作区/临时目录边界：仅在宿主确认执行 cwd、单个字面目标、非递归、非 `.git`、路径 containment 和可写沙箱等证据完整时交宿主执行；同时修复同树可接续 `send_message` 因 tools guard 注册时序导致的误拒，调用期动态注册并保留无 guard/树外目标的 fail-closed。该版本代码已通过仓库内验证，尚未安装到本机 profile。
- `1.16.7` 修订原生审批结束后的拒绝消息：按用户拒绝、取消、审批通道不可用和无批准记录分别说明原因与下一步；保留 `DECISION_ENGINE_MANDATORY_DENY` 错误码，并附 `approvalOutcome` 分类字段。该版本代码已通过仓库内验证，尚未安装到本机 profile。
- `1.16.6` 包含 codex-auto-review guardian 审核协议适配：精确模型使用 `outcome` 协议，普通模型保持 `action` 协议；回退档位能力不匹配时提前拒绝，设置页显示不兼容提示，连通性探针不回显模型正文。该版本代码已通过仓库内验证，尚未安装到本机 profile。
- `1.16.5` 包含 DEC-089 的审计驱动 P1 修复：回退前校验所选模型是否支持显式 `reasoningEffort`，不支持或元数据无法核实时在 `llm.stream` 前按固定失败返回，不自动换模型、改档位或切换到其他路由，失败不缓存；沙箱权限请求按宿主契约细分——只有 `write`/`edit`/`bash`/`pwsh` 在契约满足时，与当前有效 mode 相同的请求才按 no-op 放行（`pwsh` 请求必须带非空说明，`fs`/`bash` 单独出现的空说明按宿主行为视同省略）；非法枚举或类型、缺失或非法说明、`danger-full-access` 下请求 `workspace-write` 这类不更宽的请求归 `invalid_request` 并在本地拒绝；真正严格更宽的请求归 `privileged` 交宿主审批；有效 mode 无法核实时保守归 `privileged`，不判无效也不放宽。该版本代码只经过仓库内验证，尚未安装到本机 profile。
- `1.16.4` 包含 DEC-088：`write`/`edit`/`bash`/`pwsh` 携带与当前有效沙箱相同的 `sandbox_permissions` 时不再被误判为提权，宿主对这一组合本就不升级权限、也不发起审批；拒绝提示补一行实际触发约束，错误码与审计字段不变。更宽、更窄、无效或无法核实的请求，以及其他工具携带的同名字段，仍按原有保守规则处理。
- `1.16.3` 包含 DEC-086/087：请求与协议故障不再缓存，正常模型裁决仍可复用；新增脱敏回退失败分类，不重复累计复用的历史耗时；引入上游模型平铺截图，暂缓含 D1/cron 的站点部署迁移。
- `1.16.2` 包含 DEC-084/085：为 `send_message` 增加脱敏核验阶段与失败原因审计，补齐 sibling、child→root、深层成员和负向审批回归矩阵；通信放行条件不变。
- `1.16.1` 包含 DEC-082：越界 write/edit 按配置交给宿主，autonomous + never + safe 写不再被 fallback 误拒；never 阻断保留原始 mandatory 原因，safe 软拒绝在有审批通道时转为宿主 ask。
- `1.16.0` 包含 DEC-080/081：安全写在无审批通道且非自动审查时跳过无效的模型复核；记忆复用保留来源、失败状态和审计字段；shell/内部工具只在严格契约下静态放行；primary 与 fallback 共享授权总时限；决策记录带插件版本与 schema 版本。
- `1.15.1` 包含 DEC-077/078：彻底移除匿名统计控件、安装 ID、心跳上报及网站采集/日报链路，保留本地决策历史与统计；强制审批区分策略禁止和通道不可用，直接给出双语停止重试指引与独立错误码，删除与提权提示分开，不降低原生审批权限边界。
- `1.15.0` 包含 DEC-076：审批通道为 `never` 时，`mandatory=safe` 调用交宿主沙箱、非 safe 的 ask 交回退裁决（不再被模型一票否决）；同会话同参 120 秒内复用首次裁决；`reasonCode` 稳定枚举化（档位 note 只进 humanReason）。`1.14.0` 的 DEC-075、`1.13.0` 的 DEC-074、`1.12.0` 的 DEC-072/073、`1.11.2` 的 never 回退、`1.11.1` 的 DEC-070、`1.11.0` 的审计修复、`1.10.0` 的五项改动依次见 DEC-062 ~ DEC-075。
- checkout 与 setup-vp Action 固定到已核对的 commit SHA；不通过 `pull_request_target` 运行不可信 PR。
- 验证任务只有 `contents: read`；只有发布 job 有 `id-token: write`。发布 step 只使用 OIDC（trusted publishing），不再读取任何 npm token secret。代码 checkout 不保留 Git 凭据。此工作流不会自动修改版本、提交源码或推送 Git。

## npm 授权：一次性登记，工作流只用 OIDC

发布工作流**只走 npm Trusted Publishing**：publish job 只有 `contents: read` 与 `id-token: write`，npm 把 GitHub Actions 的 OIDC 身份换成短期凭据并生成 provenance。仓库不再需要 `NPM_TOKEN` secret，`publish.yml` 中也不存在任何 `NODE_AUTH_TOKEN`；首次发包之后直接用长期 token 在 workflow 内 bootstrap 的做法已废弃。

首次登记是一次性、由有 `@leonhardthust` scope 发布权限的账号手动执行的动作。npm 的信任关系管理 API 要求 2FA/一次性口令（OTP），非交互环境只会返回 `EOTP`，因此必须在能弹出浏览器完成验证的终端里跑：

```powershell
$env:HTTP_PROXY = "http://localhost:7897"
$env:HTTPS_PROXY = "http://localhost:7897"
$env:npm_config_cache = Join-Path (Get-Location) "release-artifacts/npm-cache"
npm trust github @leonhardthust/dsh-decision-engine --file publish.yml --repository LeonhardtHUST/dsh-decision-engine --allow-publish --registry "https://registry.npmjs.org/" --yes
```

- 该命令登记 owner/repo/workflow 三元组；同一关系重复登记只是覆盖，不需要先 `revoke`。它不接受把 `--cache` 当位置参数，缓存只用进程环境变量 `npm_config_cache` 指定；registry 始终显式写 npmjs 官方地址。
- 回读用 `npm trust list @leonhardthust/dsh-decision-engine`，但 **list 与 create 一样会触发 OTP 挑战**。非交互环境返回 `EOTP` 属预期：此时登记状态无法从命令行独立核验，只能查看 npm 包设置页的 publishing access，或观察下一次 OIDC 发布的结果。不要为回读反复重发挑战，不要打开 CLI 打印的 `doneUrl`，也不要把挑战换回的 token 读取、复制或落盘。
- 登记后不要再配置长期 `NPM_TOKEN` 发布路径；若需回退，改用下文的手动发布，不要在工作流里重新注入长期 token。
- 认证直接调用原生 npm，不经过 `vp pm login` 的参数透传；已观察到该透传把 registry 错误解析成 `https` 后回落到镜像。仓库依赖与验证任务继续由 vp 管理。CLI 必须显示 npmjs 官方 registry；出现 npmmirror 等镜像时立即取消。代理变量只在本次进程内生效。不要把 npm token 贴到聊天、提交到源码或打印到 CI 日志。网页登录和二次验证由用户完成。
- 工作流要求 runner 自带的 npm CLI 支持 trusted publishing（最低 npm 11.5.1；管理登记命令已核对本机 npm 11.20.0）；OIDC 发布必须带 `--provenance`。

不要把仅有 GitHub 仓库 ADMIN 权限理解成拥有 npm scope 权限。

## 发布前检查

```powershell
vp install --frozen-lockfile
vp run verify
vp run verify:guard
vp run pack:release
vp run verify:package
vp run verify:release
```

被校验的产物目录必须只有本次发布的一个 `.tgz`。需要保留旧版 tarball 时，使用独立目录，例如 `vp pm pack --pack-destination release-artifacts/npm-1.16.4 --json`，随后运行 `vp exec node scripts/verify-package.mjs release-artifacts/npm-1.16.4`。安全情景也可通过 `vp exec node scripts/verify-guard-scenarios.mjs release-artifacts/guard-1.16.4` 独立输出，避免覆盖未提交的 benchmark 修改。目录和 tarball 被 Git 忽略。

`verify:package` 读取真正的 gzip/tar，检查 manifest、scoped 模块 id、bundle 引用、全部安全模块、locale、图表资源和相对 import。配置、凭据、日志、测试目录等不能进入包。输出文件数、大小和 SHA-512 integrity。

本次 Windows 串行验证：CI 入口 `vp run verify`（`test/*.test.js`）1365/1365 通过并接入线检查，guard 定向 484/484、隔离安全情景 96/96 通过；另以默认直接 `node --test` 发现串行跑通 1366/1366，默认发现范围的计数与 CI 入口不同，并非少跑测试。默认并发运行时曾出现 1 项 Windows 临时目录清理 `EPERM`，属既有问题（LOG-009，与 `engine.test.js` 旧 baseline 同类），已单独登记，不计入本次回归。工作区沙箱下测试运行器的子进程管道可能报 `spawn EPERM`：只有确认是 sandbox 拒绝、且宿主审批通道可用时，才按宿主流程对同一条命令单次授权，不改全局设置；审批通道为 `never` 时不得设置 `sandbox_permissions`，也不得换命令绕过，应如实报告这一限制。旧验证检查点及安全边界见 `bench/guard-revision/validation.md` 与 `docs/auto-review-hotfix.md`（完整证据仅在源码仓库保留）。发布 CI 选择 Linux，依然必须运行完整测试，不跳过或忽略它们；本机验证通过不等同于 CI 发布成功。

发布完成后，核对 npmjs 的确切版本、`latest`、provenance 和官方 tarball 内容。不能仅凭本地测试通过、推送成功或 workflow 绿色宣布发布成功。

## 手动发布相同的已验证 tarball

这是本地兜底路径：需要交互式 `npm login` 并当场完成 2FA/OTP，不走 OIDC，也不会生成本地 provenance。日常发版应让 Actions 工作流发布。

授权及完整验证均满足后：

```powershell
npm publish ./release-artifacts/npm-1.16.6/leonhardthust-dsh-decision-engine-1.16.6.tgz --registry "https://registry.npmjs.org/" --access public --tag latest
npm view @leonhardthust/dsh-decision-engine version --registry "https://registry.npmjs.org/" --json
```

本地发布不伪造 GitHub provenance；在 GitHub Actions 中由工作流增加 `--provenance`。发布操作不可覆盖已存在的同版本；已发布版本的后续提交会跳过发布。若升版后的 CI 失败，修复代码并推送 main 会自动重试仍未发布的版本，无需再升版或手动触发。npmjs 查询错误会停止，不能把网络或权限错误当成未发布。自动检测不自动修改版本或源码。

## 安装

DSH 插件管理中使用 `@leonhardthust/dsh-decision-engine` 或指定 `@leonhardthust/dsh-decision-engine@1.16.6`。安装和启用是另外的用户动作，发布工作流不会修改本机 DSH profile。
