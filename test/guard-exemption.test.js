import test from "node:test";
import assert from "node:assert/strict";
import { join, parse, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

import { buildTrustedContext } from "../lib/guard/context.js";
import { boundedDestructivePath, boundedDestructiveTarget, classifyToolEffect } from "../lib/guard/effects.js";
import { evaluateMandatoryPolicy } from "../lib/guard/policy.js";
import { createGuardFixture as createBaseGuardFixture } from "./helpers/guard-fixture.js";

const WORKSPACE = "/fixture/workspace";
const TEMP = "/fixture/temp";

function decide({ toolName = "pwsh", args, trustedContext = {} }) {
  const effect = classifyToolEffect({ toolName, args, trustedContext });
  return { effect, mandatory: evaluateMandatoryPolicy({ context: trustedContext, effect }) };
}

test("有界删除只认单命令、单目标、零开关的封闭形状", () => {
  const accepted = [
    ["pwsh", "Remove-Item build/out.log", "remove-item", "build/out.log"],
    ["pwsh", "remove-item 'build dir/out.log'", "remove-item", "build dir/out.log"],
    ["pwsh", 'Remove-Item "build/out.log"', "remove-item", "build/out.log"],
    ["pwsh", "rm build/out.log", "rm", "build/out.log"],
    ["pwsh", "del build\\out.log", "del", "build\\out.log"],
    ["pwsh", "erase build/out.log", "erase", "build/out.log"],
    ["bash", "rm build/out.log", "rm", "build/out.log"],
  ];
  for (const [toolName, command, commandName, target] of accepted) {
    assert.deepEqual(boundedDestructiveTarget({ toolName, args: { command } }), { commandName, target }, command);
  }
  const rejected = [
    "Remove-Item build/out.log extra",
    "Remove-Item -Recurse build",
    "Remove-Item build/out.log -Force",
    "Remove-Item build/*.log",
    "Remove-Item build/out?.log",
    "Remove-Item $env:TEMP/out.log",
    "Remove-Item ${HOME}/out.log",
    "Remove-Item @targets",
    "Remove-Item '@targets'",
    'Remove-Item "@targets"',
    "Remove-Item @args",
    "Remove-Item @$targets",
    "Remove-Item @('a','b')",
    "Remove-Item ${targets}",
    'Remove-Item "${targets}"',
    "Remove-Item $($targets)",
    "Remove-Item env:TEMP",
    "Remove-Item variable:targets",
    "Remove-Item C:\\fixture\\out.log:stream",
    "Remove-Item `build/out.log`",
    "Get-Location | Remove-Item build",
    "Get-Location > out.log; Remove-Item build",
    "Remove-Item build; Remove-Item other",
    "Remove-Item && build",
    "Remove-Item ../outside.log",
    "Remove-Item .git/config",
    "Remove-Item .",
    "Remove-Item ./",
    "Remove-Item C:\\",
    "Remove-Item C:",
    "Remove-Item C:relative.log",
    "Remove-Item \\\\host\\share\\out.log",
    "Remove-Item //host/share/out.log",
    "Remove-Item ~/out.log",
    "Remove-Item 'a' extra",
    "Remove-Item a\nb",
    "Remove-Item",
    "Clear-Content build/out.log",
    "Format-Volume",
  ];
  for (const command of rejected) assert.equal(boundedDestructiveTarget({ toolName: "pwsh", args: { command } }), undefined, command);
  // 命令族之外的调用方不会凭空得到豁免候选。
  assert.equal(boundedDestructiveTarget({ toolName: "read", args: { command: "Remove-Item a.txt" } }), undefined);
  assert.equal(boundedDestructiveTarget({ toolName: "pwsh", args: { command: 42 } }), undefined);
  // 路径级检查可以单独复用：盘符根、UNC、`.git`、`..` 都不是有界目标。
  for (const value of ["/", "C:\\", "\\\\host\\share", "a/../b", ".git/config", "", " build/out.log", "@targets", "$targets", "${targets}", "$(targets)", "env:TEMP", "out.log:stream"]) assert.equal(boundedDestructivePath(value), false, value);
  for (const command of ["rm ${targets}", "rm ${targets[@]}", 'rm "$@"', "rm {a,b}", "rm $(targets)", "rm build\\out.log", "rm 'build\\out.log'"]) {
    assert.equal(boundedDestructiveTarget({ toolName: "bash", args: { command } }), undefined, command);
  }
  for (const value of ["build/out.log", "C:\\fixture\\out.log", "build dir/out.log", ".\\build\\out.log"]) assert.equal(boundedDestructivePath(value), true, value);
});

test("工作区/临时目录内的有界删除把一刀切 mandatory 降为交宿主沙箱", () => {
  const workspace = decide({ args: { command: "Remove-Item build/out.log" }, trustedContext: { sandboxMode: "workspace-write", destructiveTargetScope: "workspace" } });
  assert.equal(workspace.effect.kind, "destructive");
  assert.equal(workspace.effect.known, true);
  assert.equal(workspace.effect.highImpact, true, "仍标记为破坏性效应，不能洗成只读");
  assert.deepEqual(workspace.effect.reasonCodes, ["possible-shell-destructive-effect", "bounded-local-destructive-exempt"]);
  assert.deepEqual(workspace.effect.exemption, { kind: "bounded-local-destructive", commandName: "remove-item", targetScope: "workspace", targetCount: 1 });
  assert.equal(workspace.mandatory.status, "safe");
  assert.deepEqual(workspace.mandatory.reasonCodes, ["bounded-local-destructive-defer-to-host"]);
  assert.ok(workspace.mandatory.evidence.some((item) => item.field === "destructiveTargetScope" && item.value === "workspace"));
  assert.ok(workspace.mandatory.evidence.some((item) => item.field === "destructiveTargetCount" && item.value === 1));
  assert.ok(workspace.mandatory.evidence.some((item) => item.field === "sandboxMode" && item.value === "workspace-write"));

  const temp = decide({ toolName: "bash", args: { command: "rm /fixture/temp/out.log" }, trustedContext: { sandboxMode: "danger-full-access", destructiveTargetScope: "temp" } });
  assert.equal(temp.mandatory.status, "safe");
  assert.deepEqual(temp.effect.exemption, { kind: "bounded-local-destructive", commandName: "rm", targetScope: "temp", targetCount: 1 });
});

test("缺任何一维证据都保持原有 requires_approval", () => {
  const workspace = { sandboxMode: "workspace-write", destructiveTargetScope: "workspace" };
  const cases = [
    ["没有宿主路径证据", { sandboxMode: "workspace-write" }, { command: "Remove-Item build/out.log" }, "pwsh"],
    ["目标解析到工作区外", { sandboxMode: "workspace-write", destructiveTargetScope: "outside" }, { command: "Remove-Item build/out.log" }, "pwsh"],
    ["目标是工作区根或 .git（protected）", { sandboxMode: "workspace-write", destructiveTargetScope: "protected" }, { command: "Remove-Item build/out.log" }, "pwsh"],
    ["只读沙箱", { sandboxMode: "read-only", destructiveTargetScope: "workspace" }, { command: "Remove-Item build/out.log" }, "pwsh"],
    ["沙箱模式未知", { destructiveTargetScope: "workspace" }, { command: "Remove-Item build/out.log" }, "pwsh"],
    ["命令多目标", workspace, { command: "Remove-Item a.txt b.txt" }, "pwsh"],
    ["递归开关", workspace, { command: "Remove-Item -Recurse build" }, "pwsh"],
    ["强制开关", workspace, { command: "Remove-Item build/out.log -Force" }, "pwsh"],
    ["bash 递归开关", workspace, { command: "rm -rf build" }, "bash"],
    ["通配符目标", workspace, { command: "Remove-Item build/*.log" }, "pwsh"],
    ["环境变量目标", workspace, { command: "Remove-Item $env:TEMP/build.log" }, "pwsh"],
    ["PowerShell splatting", workspace, { command: "Remove-Item @targets" }, "pwsh"],
    ["带引号的 splatting 形态", workspace, { command: "Remove-Item '@targets'" }, "pwsh"],
    ["PowerShell 参数展开", workspace, { command: 'Remove-Item "${targets}"' }, "pwsh"],
    ["bash 参数展开", workspace, { command: 'rm "$@"' }, "bash"],
    ["管道串联", workspace, { command: "Get-Location | Remove-Item build" }, "pwsh"],
    ["分号串联", workspace, { command: "Remove-Item a.txt; Remove-Item b.txt" }, "pwsh"],
    ["穿越目录", workspace, { command: "Remove-Item ../outside.log" }, "pwsh"],
    [".git 目标", workspace, { command: "Remove-Item .git/config" }, "pwsh"],
    ["工作区根目录", workspace, { command: "Remove-Item ." }, "pwsh"],
    ["盘符根", workspace, { command: "Remove-Item C:\\" }, "pwsh"],
    ["UNC 目标", workspace, { command: "Remove-Item \\\\host\\share\\out.log" }, "pwsh"],
    ["族外破坏命令", workspace, { command: "Clear-Content build/out.log" }, "pwsh"],
    ["重置命令", workspace, { command: "git reset --hard" }, "pwsh"],
  ];
  for (const [label, trustedContext, args, toolName] of cases) {
    const { effect, mandatory } = decide({ toolName, args, trustedContext });
    assert.equal(effect.kind, "destructive", label);
    assert.equal(effect.exemption, undefined, label);
    assert.equal(mandatory.status, "requires_approval", label);
    assert.deepEqual(mandatory.reasonCodes, ["destructive-operation-requires-approval"], label);
  }
});

function canonical(value) {
  const text = String(value).replace(/\\/g, "/");
  const absolute = text.startsWith("/");
  const segments = [];
  for (const segment of text.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { segments.pop(); continue; }
    segments.push(segment);
  }
  return `${absolute ? "/" : ""}${segments.join("/")}`;
}

function hostFs({ temp = TEMP, aliases = new Map() } = {}) {
  const resolve = async (value, options = {}) => {
    if (aliases.has(value)) return aliases.get(value);
    if (value === tmpdir()) return temp;
    if (/^[A-Za-z]:[\\/]|^[\\/]/.test(value)) return canonical(value);
    return canonical(`${options.cwd ?? WORKSPACE}/${value}`);
  };
  const contains = (base, target) => {
    const left = canonical(base);
    const right = canonical(target);
    return right === left || right.startsWith(`${left.replace(/\/$/, "")}/`);
  };
  return { resolve, contains };
}

async function trustedContext(exec, services) {
  const agent = { id: "caller", session: { id: "caller", snapshotEvents: () => [] } };
  return buildTrustedContext({ agent, ctx: { get: (name) => services[name] }, exec });
}

function hostServices(fs) {
  return {
    permissionPresets: { current: () => "default", resolve: () => ({ approval: "ask", sandbox: "workspace-write" }) },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: WORKSPACE }) },
    workingDirectory: { ensure: async () => WORKSPACE },
    shell: { resolve: (request) => ({ ...request }) },
    ...(fs === undefined ? {} : { fs }),
  };
}

async function createGuardFixture(options) {
  const env = await createBaseGuardFixture(options);
  env.services.workingDirectory = { ensure: async () => env.root };
  env.services.shell = { resolve: (request) => ({ ...request }) };
  return env;
}

test("目标位置由宿主 fs 解析后判定，而不是靠词法形态", async () => {
  const inside = await trustedContext({ name: "pwsh", arguments: { command: "Remove-Item build/out.log" } }, hostServices(hostFs()));
  assert.equal(inside.destructiveTargetScope, "workspace");
  assert.deepEqual(inside.availability.destructiveTargetScope, { available: true, reason: "host-observed" });
  assert.ok(inside.evidence.some((item) => item.field === "destructiveTargetScope" && item.value === "workspace"));

  const temp = await trustedContext({ name: "pwsh", arguments: { command: "Remove-Item /fixture/temp/out.log" } }, hostServices(hostFs()));
  assert.equal(temp.destructiveTargetScope, "temp");

  const outside = await trustedContext({ name: "bash", arguments: { command: "rm /outside/fixture.log" } }, hostServices(hostFs()));
  assert.equal(outside.destructiveTargetScope, "outside");

  const root = await trustedContext({ name: "pwsh", arguments: { command: `Remove-Item ${WORKSPACE}` } }, hostServices(hostFs()));
  assert.equal(root.destructiveTargetScope, "protected");

  // 词法上像工作区内文件，但宿主解析把它指到 `.git` 里：必须保持受保护。
  const gitAlias = new Map([["fixture-link", `${WORKSPACE}/.git/config`]]);
  const linked = await trustedContext({ name: "pwsh", arguments: { command: "Remove-Item fixture-link" } }, hostServices(hostFs({ aliases: gitAlias })));
  assert.equal(linked.destructiveTargetScope, "protected");

  const missingFs = await trustedContext({ name: "pwsh", arguments: { command: "Remove-Item build/out.log" } }, hostServices(undefined));
  assert.equal(missingFs.destructiveTargetScope, "unknown");
  assert.deepEqual(missingFs.availability.destructiveTargetScope, { available: false, reason: "host-field-unavailable" });

  const unresolved = await trustedContext({ name: "pwsh", arguments: { command: "Remove-Item -Recurse build" } }, hostServices(hostFs()));
  assert.equal(unresolved.destructiveTargetScope, "unknown");
  assert.equal(unresolved.availability.destructiveTargetScope, undefined, "形状不成立时不该发起路径查询");
});

test("相对目标绑定宿主当前执行 cwd，不能借工作区根或会话初始目录", async () => {
  for (const toolName of ["pwsh", "bash"]) {
    const services = hostServices(hostFs());
    services.workingDirectory.ensure = async (agent) => {
      assert.equal(agent.session.header.cwd, WORKSPACE, "初始目录不等于当前目录");
      return "/outside/current";
    };
    const command = toolName === "pwsh" ? "Remove-Item out.log" : "rm out.log";
    const exec = { name: toolName, arguments: { command } };
    const context = await buildTrustedContext({ agent: { id: "caller", session: { id: "caller", header: { cwd: WORKSPACE } } }, ctx: { get: (name) => services[name] }, exec });
    assert.equal(context.destructiveTargetScope, "outside", toolName);
    assert.equal(context.destructiveExecutionCwd, "/outside/current", toolName);
    assert.equal(decide({ toolName, args: exec.arguments, trustedContext: context }).mandatory.status, "requires_approval", toolName);
    assert.ok(context.evidence.some((item) => item.field === "destructiveExecutionCwd" && item.source === "workingDirectory.ensure+shell.resolve"));
  }
});

test("workdir 只使用宿主 shell.resolve 确认的目录，不直接相信调用方字符串", async () => {
  for (const toolName of ["pwsh", "bash"]) {
    const command = toolName === "pwsh" ? "Remove-Item out.log" : "rm out.log";
    const services = hostServices(hostFs());
    const requests = [];
    services.shell.resolve = (request) => { requests.push(request); return { ...request, workdir: "/outside/effective" }; };
    const mismatch = await trustedContext({ name: toolName, arguments: { command, workdir: WORKSPACE } }, services);
    assert.equal(requests[0].workdir, WORKSPACE);
    assert.equal(mismatch.destructiveExecutionCwd, "/outside/effective");
    assert.equal(mismatch.destructiveTargetScope, "outside");

    services.shell.resolve = (request) => ({ ...request });
    const outside = await trustedContext({ name: toolName, arguments: { command, workdir: "/outside/requested" } }, services);
    assert.equal(outside.destructiveTargetScope, "outside");
    // 相对 workdir 使用宿主工具的 native path 规则，不能在 Windows fixture
    // 中把 POSIX /fixture 路径归一化后的盘符误当成越界。
    const nativeWorkspace = resolvePath(WORKSPACE);
    services.workingDirectory.ensure = () => nativeWorkspace;
    services.sandboxPolicy.resolve = () => ({ mode: "workspace-write", workspaceRoot: nativeWorkspace });
    const relative = await trustedContext({ name: toolName, arguments: { command, workdir: "build" } }, services);
    assert.equal(relative.destructiveTargetScope, "workspace");

    delete services.shell;
    const unconfirmed = await trustedContext({ name: toolName, arguments: { command, workdir: WORKSPACE } }, services);
    assert.equal(unconfirmed.destructiveTargetScope, "unknown");
    assert.deepEqual(unconfirmed.availability.destructiveExecutionCwd, { available: false, reason: "host-field-unavailable" });
  }
});

test("执行目录服务缺失、异常或返回非绝对目录时不豁免", async () => {
  const cases = [
    ["missing", (services) => { delete services.workingDirectory; }],
    ["ensure throws", (services) => { services.workingDirectory.ensure = () => { throw new Error("fixture-cwd-failed"); }; }],
    ["ensure relative", (services) => { services.workingDirectory.ensure = () => "relative"; }],
    ["shell throws", (services) => { services.shell.resolve = () => { throw new Error("fixture-shell-failed"); }; }],
    ["shell missing cwd", (services) => { services.shell.resolve = () => ({}); }],
    ["shell relative cwd", (services) => { services.shell.resolve = () => ({ workdir: "relative" }); }],
  ];
  for (const [label, mutate] of cases) {
    const services = hostServices(hostFs());
    mutate(services);
    const args = { command: "Remove-Item out.log", workdir: WORKSPACE };
    const context = await trustedContext({ name: "pwsh", arguments: args }, services);
    assert.equal(context.destructiveTargetScope, "unknown", label);
    assert.equal(decide({ args, trustedContext: context }).mandatory.status, "requires_approval", label);
    assert.equal(context.evidence.some((item) => item.field === "destructiveTargetScope"), false, label);
  }
});

test("保护目录解析或包含核验异常必须 fail-closed，不能继续 workspace/temp 放行", async () => {
  const cases = [
    ["git resolve throws", (fs) => { const resolve = fs.resolve; fs.resolve = (value, options) => { if (value === ".git") throw new Error("fixture-git-failed"); return resolve(value, options); }; }],
    ["git resolve unknown", (fs) => { const resolve = fs.resolve; fs.resolve = (value, options) => value === ".git" ? undefined : resolve(value, options); }],
    ["git resolve invalid", (fs) => { const resolve = fs.resolve; fs.resolve = (value, options) => value === ".git" ? false : resolve(value, options); }],
    ["git contains throws", (fs) => { const contains = fs.contains; fs.contains = (base, target) => { if (base === `${WORKSPACE}/.git`) throw new Error("fixture-contains-failed"); return contains(base, target); }; }],
    ["git contains unknown", (fs) => { const contains = fs.contains; fs.contains = (base, target) => base === `${WORKSPACE}/.git` ? undefined : contains(base, target); }],
    ["temp resolve throws", (fs) => { const resolve = fs.resolve; fs.resolve = (value, options) => { if (value === tmpdir()) throw new Error("fixture-temp-failed"); return resolve(value, options); }; }],
    ["temp resolve unknown", (fs) => { const resolve = fs.resolve; fs.resolve = (value, options) => value === tmpdir() ? undefined : resolve(value, options); }],
    ["temp contains unknown", (fs) => { const contains = fs.contains; fs.contains = (base, target) => base === TEMP ? null : contains(base, target); }],
  ];
  for (const [label, mutate] of cases) {
    for (const target of ["build/out.log", `${TEMP}/out.log`]) {
      const fs = hostFs();
      mutate(fs);
      const args = { command: `Remove-Item ${target}` };
      const context = await trustedContext({ name: "pwsh", arguments: args }, hostServices(fs));
      assert.equal(context.destructiveTargetScope, "unknown", `${label}: ${target}`);
      assert.deepEqual(context.availability.destructiveTargetScope, { available: false, reason: "host-query-failed" }, label);
      assert.equal(decide({ args, trustedContext: context }).mandatory.status, "requires_approval", label);
    }
  }
});

test("never 下 cwd/workdir 不匹配、splatting 和保护目录异常都在模型前拒绝", async () => {
  const cases = [
    ["当前目录在外部", "Remove-Item out.log", {}, (services) => { services.workingDirectory.ensure = () => "/outside/current"; }],
    ["显式 workdir 在外部", "Remove-Item out.log", { workdir: "/outside/requested" }, () => {}],
    ["workdir 未获宿主确认", "Remove-Item out.log", { workdir: WORKSPACE }, (services) => { delete services.shell; }],
    ["PowerShell splatting", "Remove-Item @targets", {}, () => {}],
    ["保护目录解析失败", "Remove-Item out.log", {}, (services) => { const resolve = services.fs.resolve; services.fs.resolve = (value, options) => { if (value === ".git") throw new Error("fixture-git-failed"); return resolve(value, options); }; }],
  ];
  for (const [label, command, extra, mutate] of cases) {
    const env = await createGuardFixture({ preset: "manual", approval: "never", sandbox: "danger-full-access" });
    try {
      mutate(env.services);
      const { decision } = await env.run("pwsh", { command, ...extra });
      assert.equal(decision.kind, "deny", label);
      assert.equal(decision.info.reason, "approval-policy-never", label);
      assert.equal(env.records[0].audit.mandatory.status, "requires_approval", label);
      assert.equal(env.modelCalls, 0, label);
      assert.equal(env.fallbackCalls, 0, label);
      assert.equal(env.sideEffects, 0, label);
    } finally { await env.cleanup(); }
  }
});

test("never 下工作区内单文件删除直接交宿主，outside 与只读仍然拒绝", async () => {
  const env = await createGuardFixture({ preset: "manual", approval: "never", sandbox: "danger-full-access", choice: "high", reviewAction: "deny" });
  try {
    const { decision } = await env.run("pwsh", { command: "Remove-Item removed-fixture.txt" });
    assert.equal(decision.kind, "allow");
    assert.equal(env.modelCalls, 0, "本地证据完整时不再调用决策模型");
    assert.equal(env.fallbackCalls, 0);
    assert.equal(env.sideEffects, 1);
    const audit = env.records[0].audit;
    assert.equal(audit.mandatory.status, "safe");
    assert.equal(audit.reasonCode, "bounded-local-destructive-defer-to-host");
    assert.equal(audit.effect.kind, "destructive");
    assert.equal(audit.policyBlockReason, "unknown", "没有强制审批拦截，审计不应伪造约束原因");
  } finally { await env.cleanup(); }
});

test("never 下工作区外的单目标删除仍然是一刀切拒绝", async () => {
  const env = await createGuardFixture({ preset: "manual", approval: "never", sandbox: "danger-full-access" });
  try {
    const outside = join(parse(env.root).root, "fixture-outside-deletion.txt");
    const { decision } = await env.run("pwsh", { command: `Remove-Item "${outside}"` });
    assert.equal(decision.kind, "deny");
    assert.equal(decision.info.reason, "approval-policy-never");
    assert.equal(env.modelCalls, 0);
    assert.equal(env.sideEffects, 0);
    const audit = env.records[0].audit;
    assert.equal(audit.mandatory.status, "requires_approval");
    assert.deepEqual(audit.mandatory.reasonCodes, ["destructive-operation-requires-approval"]);
    assert.equal(audit.policyBlockReason, "destructive-operation-requires-approval");
  } finally { await env.cleanup(); }
});

test("只读沙箱下即使目标在工作区内也不豁免", async () => {
  const env = await createGuardFixture({ preset: "manual", approval: "never", sandbox: "read-only" });
  try {
    const { decision } = await env.run("pwsh", { command: "Remove-Item removed-fixture.txt" });
    assert.equal(decision.kind, "deny");
    assert.equal(env.records[0].audit.mandatory.status, "requires_approval");
    assert.equal(env.sideEffects, 0);
  } finally { await env.cleanup(); }
});

test("有审批通道时删除仍先过模型复核，不因豁免跳过确认", async () => {
  const env = await createGuardFixture({ preset: "manual", approval: "ask", sandbox: "danger-full-access", choice: "high" });
  try {
    const { decision } = await env.run("pwsh", { command: "Remove-Item removed-fixture.txt" });
    assert.equal(decision.kind, "ask");
    assert.equal(env.modelCalls, 1);
    assert.equal(env.sideEffects, 0);
    assert.equal(env.records[0].audit.mandatory.status, "safe", "豁免只去掉强制审批，不伪造风险");
  } finally { await env.cleanup(); }
});
