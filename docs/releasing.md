# npm 发布

发布目标：`@leonhardthust/dsh-decision-engine`，当前版本 `1.9.0`，公开包。

本分支基于 `zuosus/dsh-decision-engine` 的 MIT 代码，保留原作者与许可证；npm scope、源码仓库、bundle 引用和浏览器主模块 / charts chunk 标识已同步为本分支身份。内部 API、样式标识和用户数据目录保留旧名称以兼容已有配置。不要同时启用原包与本 scoped fork，它们提供相同的服务与页面。

## 工作流

- `.github/workflows/ci.yml`：main push、PR、手动运行或发布工作流复用；Ubuntu 24.04 + Node.js 24 + Vite+ 1.6.0。执行 frozen install、完整测试与接线、隔离情景、实际打包和 tarball 检查。失败不会被忽略。
- `.github/workflows/publish.yml`：版本 tag push 或 main 上手动运行。只有 `LeonhardtHUST/dsh-decision-engine` 可以进入发布；发布必须等待上述 CI 成功。
- 手动运行必须填写与 manifest 完全一致的 `v1.9.0`。后续发版同步修改 manifest 与 tag。预发布版本不能覆盖 npm `latest`。
- checkout 与 setup-vp Action 固定到已核对的 commit SHA；不通过 `pull_request_target` 运行不可信 PR。
- 验证任务只有 `contents: read`；只有发布 job 有 `id-token: write`。代码 checkout 不保留 Git 凭据。此工作流不会自动修改版本、提交源码或推送 Git。

## npm 授权

首次发包通常需要先用有 `@leonhardthust` scope 发布权限的账号登录：

```powershell
$env:HTTPS_PROXY = "http://localhost:7897"
$env:HTTP_PROXY = "http://localhost:7897"
npm config get registry --registry "https://registry.npmjs.org/"
npm login --registry "https://registry.npmjs.org/" --auth-type web
npm whoami --registry "https://registry.npmjs.org/"
```

认证直接调用原生 npm，不经过当前 `vp pm login` 的参数透传；已观察到该透传把 registry 错误解析成 `https` 后回落到镜像。仓库依赖与验证任务继续由 vp 管理。CLI 必须显示 npmjs 官方 registry；出现 npmmirror 等镜像时立即取消。代理环境变量只影响这个终端。不要把 npm token 贴到聊天、提交到源码或打印到 CI 日志。网页登录和二次验证由用户完成。

CI 发布支持两种授权：

1. **npm Trusted Publishing（优先）**：在 npm 包设置登记 GitHub owner=`LeonhardtHUST`、repo=`dsh-decision-engine`、workflow=`publish.yml`。工作流用 OIDC 和支持 trusted publishing 的 npm CLI 发布，并生成 provenance；不必保存长期 token。首次创建 scoped 包后再配置可信发布者。
2. **已有发布凭据**：仓库 Actions secret `NPM_TOKEN`。工作流仅在最后的授权与发布步骤提供它，临时 npmrc 使用环境变量引用，不把 token 插进文件内容。token 权限与 npm 的 2FA/发布策略必须允许该包发布；未授权会明确失败，不静默换身份。

不要把仅有 GitHub 仓库 ADMIN 权限理解成拥有 npm scope 权限。

## 发布前检查

```powershell
vp install --frozen-lockfile
vp run verify
vp run verify:guard
vp run pack:release
vp run verify:package
$env:RELEASE_TAG = "v1.9.0"
vp run verify:release
```

`release-artifacts/` 必须只有本次发布的一个 `.tgz`；重复打包前手动核对其中内容，勿混入旧版 tarball。目录和 tarball 被 Git 忽略。

`verify:package` 读取真正的 gzip/tar，检查 manifest、scoped 模块 id、bundle 引用、全部安全模块、locale、图表资源和相对 import。配置、凭据、日志、测试目录等不能进入包。输出文件数、大小和 SHA-512 integrity。

当前 Windows 完整测试的 5 个基线失败及安全边界见 `bench/guard-revision/validation.md`（仅在源码仓库保留完整证据）。发布 CI 选择 Linux，依然必须运行完整测试，不跳过或忽略它们；本机专测通过不等同于 CI 发布成功。

## 手动发布相同的已验证 tarball

授权及完整验证均满足后：

```powershell
npm publish ./release-artifacts/leonhardthust-dsh-decision-engine-1.9.0.tgz --registry "https://registry.npmjs.org/" --access public --tag latest
npm view @leonhardthust/dsh-decision-engine version --registry "https://registry.npmjs.org/" --json
```

本地发布不伪造 GitHub provenance；在 GitHub Actions 中由工作流增加 `--provenance`。发布操作不可覆盖已存在的同版本；版本冲突必须停止，不自动递增重试。

## 安装

DSH 插件管理中使用 `@leonhardthust/dsh-decision-engine` 或指定 `@leonhardthust/dsh-decision-engine@1.9.0`。安装和启用是另外的用户动作，发布工作流不会修改本机 DSH profile。
