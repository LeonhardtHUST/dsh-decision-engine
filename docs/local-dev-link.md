# 本地开发：把仓库链进 DSH profile

本页是获得授权后手动操作的示例，不描述当前本机 profile 的实际安装状态。核对现状请看 profile 的 `package.json` 和模块实际解析路径；切换、安装或更新本机 profile 需要单独授权。

改代码 → 重启 DSH → 生效。

## 做法

以本仓库路径 `<本仓库路径>` 为例，profile 里 `node_modules/@leonhardthust/dsh-decision-engine` 用软链指向本仓库：

```
~/.dsh/profiles/desktop/node_modules/@leonhardthust/dsh-decision-engine -> <本仓库路径>
```

profile 的 `package.json` 里对应声明是 `link:` 形式：

```json
"@leonhardthust/dsh-decision-engine": "link:<本仓库路径>"
```

**为什么不能只是手动建软链**：profile 用 pnpm 管理（`nodeLinker: hoisted`），
而 `package.json` 里若仍写 registry 版本号，下一次 `pnpm install` 会照 lockfile
把 registry 版本装回去，**软链被覆盖**。改成 `link:` 后 pnpm 认得它是
本地链接，重装也保留。

## 回退到 registry 版本

```sh
cd ~/.dsh/profiles/desktop
# 1. 把版本声明改回 registry 版本
# 2. 重装
pnpm install
```

## 注意

- **改配置是热加载**（`config.yml` 改了立刻生效，不用重启）。
- **改代码必须重启 DSH**：插件在启动时加载。
- 如果发现仓库 `package.json` 的版本号被改动，先看 `git diff package.json`
  确认来源再决定怎么处理。不要用 `git checkout` 整体还原，那会覆盖同一
  文件里用户未提交的修改；只手工改回不该出现的行。

## 测试

```sh
cd <本仓库>
vp install
vp run test
vp run verify:wiring
```
