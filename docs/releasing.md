# npm 发布

发布目标：`@leonhardthust/dsh-decision-engine`，当前版本 `1.16.0`，公开包。

本分支基于 `zuosus/dsh-decision-engine` 的 MIT 代码，保留原作者与许可证；npm scope、源码仓库、bundle 引用和浏览器主模块 / charts chunk 标识已同步为本分支身份。内部 API、样式标识和用户数据目录保留旧名称以兼容已有配置。不要同时启用原包与本 scoped fork，它们提供相同的服务与页面。

## 工作流

- `.github/workflows/ci.yml`：main push、PR、手动运行或发布工作流复用；Ubuntu 24.04 + Node.js 24 + Vite+ 1.6.0。执行 frozen install、完整测试与接线、隔离情景、实际打包和 tarball 检查。失败不会被忽略。
- `.github/workflows/publish.yml`：每次 `main` push 自动检测版本。先比较整个 push 的 `before` 与当前 manifest，拒绝错误包名、非法或倒退版本；再只读查询 npmjs。当前版本已上传则跳过；当前版本高于 npmjs latest 且未上传则进入完整验证及发布。多提交 push 比较整个 push 前后，不仅比较 HEAD 的父提交。
- 后续发版只需修改 `package.json` 版本并提交到 main；无需创建 tag 或手动点运行。发布依赖检测和本次提交的完整 CI 均成功，不跳过测试。稳定版本发布到 `latest`，预发布版本自动进入 `next`。
- 当前 `1.16.0` 包含 DEC-080/081：安全写在无审批通道且非自动审查时跳过无效的模型复核；记忆复用保留来源、失败状态和审计字段；shell/内部工具只在严格契约下静态放行；primary 与 fallback 共享授权总时限；决策记录带插件版本与 schema 版本。
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

`release-artifacts/` 必须只有本次发布的一个 `.tgz`；重复打包前手动核对其中内容，勿混入旧版 tarball。目录和 tarball 被 Git 忽略。

`verify:package` 读取真正的 gzip/tar，检查 manifest、scoped 模块 id、bundle 引用、全部安全模块、locale、图表资源和相对 import。配置、凭据、日志、测试目录等不能进入包。输出文件数、大小和 SHA-512 integrity。

本次 Windows 全量 1155 项测试通过；工作区沙箱下测试运行器的子进程管道会报 `spawn EPERM`，需要仅为原测试命令申请一次更宽权限，不改全局设置。旧验证检查点及安全边界见 `bench/guard-revision/validation.md` 与 `docs/auto-review-hotfix.md`（完整证据仅在源码仓库保留）。发布 CI 选择 Linux，依然必须运行完整测试，不跳过或忽略它们；本机验证通过不等同于 CI 发布成功。

## 手动发布相同的已验证 tarball

这是本地兜底路径：需要交互式 `npm login` 并当场完成 2FA/OTP，不走 OIDC，也不会生成本地 provenance。日常发版应让 Actions 工作流发布。

授权及完整验证均满足后：

```powershell
npm publish ./release-artifacts/leonhardthust-dsh-decision-engine-1.16.0.tgz --registry "https://registry.npmjs.org/" --access public --tag latest
npm view @leonhardthust/dsh-decision-engine version --registry "https://registry.npmjs.org/" --json
```

本地发布不伪造 GitHub provenance；在 GitHub Actions 中由工作流增加 `--provenance`。发布操作不可覆盖已存在的同版本；已发布版本的后续提交会跳过发布。若升版后的 CI 失败，修复代码并推送 main 会自动重试仍未发布的版本，无需再升版或手动触发。npmjs 查询错误会停止，不能把网络或权限错误当成未发布。自动检测不自动修改版本或源码。

## 安装

DSH 插件管理中使用 `@leonhardthust/dsh-decision-engine` 或指定 `@leonhardthust/dsh-decision-engine@1.16.0`。安装和启用是另外的用户动作，发布工作流不会修改本机 DSH profile。
