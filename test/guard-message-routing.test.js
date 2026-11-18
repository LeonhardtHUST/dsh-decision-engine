import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTrustedContext } from "../lib/guard/context.js";
import { classifyToolEffect } from "../lib/guard/effects.js";
import { evaluateMandatoryPolicy } from "../lib/guard/policy.js";
import { mountGuard } from "../lib/guard/listener.js";

function createMemoryFixture({ approval = "never", sender = "child", target = "sibling", active = false, guardPresent = true, config: configOverrides = {}, configure = () => {} } = {}) {
  const events = [{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Coordinate isolated fixture agents." }] } }];
  const hooks = new Map();
  const calls = [];
  const audits = [];
  const counters = { primary: 0, fallback: 0, delegated: 0, approval: 0, globalFallback: 0 };
  const root = { id: "root-agent", session: { id: "root-session" } };
  const session = { id: `${sender}-session`, snapshotEvents: () => events };
  const agent = sender === "root" ? { ...root, session: { ...session, id: root.session.id } } : { id: `${sender}-agent`, session };
  const targetId = target === "root" ? root.session.id : `${target}-session`;
  let executionGuard;
  const guardRegistrations = { count: 0, disposed: 0 };
  /**
   * 安装一份会记录注册/注销次数的执行期守卫。tools 服务可能晚于插件启动、
   * 也可能在热重载后换新对象，测试要能分别验证「服务晚到」「同一服务晚
   * 提供 guard」「服务换代」三种时序，所以注册器做成可复用的。
   */
  const installGuard = (service) => {
    service.guard = (callback) => {
      executionGuard = callback;
      guardRegistrations.count += 1;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        guardRegistrations.disposed += 1;
      };
    };
    return service;
  };
  const services = {
    permissionPresets: { current: () => "manual", resolve: () => ({ approval, sandbox: "workspace-write" }) },
    approval: { overrideOf: () => approval, request() { counters.approval += 1; throw new Error("native approval is only simulated by fixture events"); } },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write" }) },
    tools: guardPresent ? installGuard({ executable: () => ({}) }) : { executable: () => ({}) },
    subagents: {
      rootOf(caller) { calls.push(["rootOf", caller]); return root; },
      async resolveName(caller, name, signal) { calls.push(["resolveName", caller, name, signal]); return targetId; },
      async listDescendants(rootId, signal) {
        calls.push(["listDescendants", rootId, signal]);
        return rootId === root.session.id ? [{ id: targetId, kind: "child", mode: "continuable", activity: active ? "active" : "inactive" }] : [];
      },
    },
    agents: { get: () => active ? { id: targetId } : undefined },
    llm: { async *stream() { counters.fallback += 1; throw new Error("fallback must not run"); } },
  };
  agent.ctx = { get: (name) => services[name] };
  const ctx = {
    get(name) {
      if (name === "tools") return services.tools;
      if (name === "subagents") { counters.globalFallback += 1; throw new Error("global tree lookup is forbidden"); }
      return undefined;
    },
    on: (name, callback) => hooks.set(name, callback),
    effect() {},
    logger: { warn() {} },
  };
  const exec = { name: "send_message", arguments: { agent: target, message: "fixture coordination only" }, callId: "memory-call", token: Symbol("memory-call"), agent, signal: new AbortController().signal };
  configure({ services, agent, root, calls, events, targetId });
  const config = { enabled: true, guardEnabled: true, guardPolicyMode: "enforce", tolerance: "default", guardFallback: "allow", ...configOverrides };
  const listener = mountGuard(ctx, {
    getConfig: () => config,
    reloadOwnConfig: async () => {},
    effectivePointModes: () => ({ authorize: "enforce" }),
    client: { async classify() { counters.primary += 1; throw new Error("primary must not run"); }, recordDecision() {} },
    digestRecent: () => "memory fixture",
    previewArguments: (args) => JSON.stringify(args),
    logDecision: async (entry) => audits.push(entry.audit),
    recordGuardDetail() {},
  });
  return {
    agent, root, ctx, exec, services, calls, audits, counters, events, targetId, guardRegistrations,
    /** 同一 tools 服务对象后来才提供 guard（服务在、方法不在）。 */
    installToolsGuard: () => installGuard(services.tools),
    /** 模拟热重载：换一个新的 tools 服务对象，可选择新对象是否提供 guard。 */
    replaceTools({ guard = true } = {}) {
      const replacement = { executable: () => ({}) };
      if (guard) installGuard(replacement);
      services.tools = replacement;
      return replacement;
    },
    removeTools: () => { delete services.tools; },
    guard: (execution = exec) => executionGuard?.(execution),
    async run() {
      return listener(exec, async () => { counters.delegated += 1; return { kind: "fixture-delegate" }; });
    },
  };
}

function assertServiceIdentity(fixture) {
  const { calls, agent, root, exec } = fixture;
  assert.deepEqual(calls.filter(([name]) => name === "rootOf"), [["rootOf", agent]]);
  assert.deepEqual(calls.filter(([name]) => name === "resolveName"), [["resolveName", agent, exec.arguments.agent, exec.signal]]);
  assert.deepEqual(calls.filter(([name]) => name === "listDescendants"), [["listDescendants", root.session.id, exec.signal]]);
}

async function verifyContext(build, options, expectedSafe, checkIdentity = true) {
  const fixture = createMemoryFixture(options);
  const context = await build({ agent: fixture.agent, ctx: fixture.ctx, exec: fixture.exec, downstreamPolicyEnforced: options.guardPresent !== false });
  if (checkIdentity) assertServiceIdentity(fixture);
  const effect = classifyToolEffect({ toolName: fixture.exec.name, args: fixture.exec.arguments, trustedContext: context });
  const mandatory = evaluateMandatoryPolicy({ context, effect });
  assert.equal(effect.kind, "internal_message");
  assert.equal(effect.targetVerified, expectedSafe);
  assert.equal(effect.highImpact, !expectedSafe);
  assert.equal(mandatory.status, expectedSafe ? "safe" : "requires_approval");
  assert.equal(context.messageTarget.permissions, "unknown");
  assert.equal(fixture.counters.globalFallback, 0);
  return { fixture, context, effect, mandatory };
}

const directions = [
  { label: "root to active child", sender: "root", target: "child", active: true },
  { label: "root to idle child", sender: "root", target: "child", active: false },
  { label: "child to root", sender: "child", target: "root" },
  { label: "sibling to active sibling", sender: "child", target: "sibling", active: true },
  { label: "sibling to idle sibling", sender: "child", target: "sibling", active: false },
  { label: "child to deep descendant", sender: "child", target: "grandchild/deep", active: false },
];

const failures = [
  { label: "outside tree despite live registry", active: true, configure({ services }) { services.subagents.listDescendants = async () => []; } },
  { label: "one-shot despite live registry", active: true, configure({ services, targetId }) { services.subagents.listDescendants = async () => [{ id: targetId, kind: "child", mode: "one-shot" }]; } },
  { label: "diagnostic despite matching id", configure({ services, targetId }) { services.subagents.listDescendants = async () => [{ id: targetId, kind: "diagnostic", mode: "continuable" }]; } },
  { label: "global guard missing", guardPresent: false },
  { label: "scoped service missing", configure({ services }) { delete services.subagents; } },
  { label: "scoped service lookup throws", configure({ agent, services }) { agent.ctx.get = (name) => { if (name === "subagents") throw new Error("scoped service unavailable"); return services[name]; }; } },
  ...["rootOf", "resolveName", "listDescendants"].flatMap((method) => [
    { label: `${method} missing`, configure({ services }) { delete services.subagents[method]; } },
    { label: `${method} throws`, configure({ services }) { services.subagents[method] = () => { throw new Error("isolated query failure"); }; } },
  ]),
  { label: "root has no identity", configure({ services }) { services.subagents.rootOf = () => ({}); } },
  { label: "root is unavailable", configure({ services }) { services.subagents.rootOf = () => undefined; } },
  { label: "name is unresolved", configure({ services }) { services.subagents.resolveName = async () => undefined; } },
  { label: "name is malformed", configure({ services }) { services.subagents.resolveName = async () => ({ id: "sibling-session" }); } },
  { label: "directory is unavailable", configure({ services }) { services.subagents.listDescendants = async () => undefined; } },
  { label: "directory is malformed", configure({ services }) { services.subagents.listDescendants = async () => ({}); } },
  { label: "directory contains invalid entry", configure({ services }) { services.subagents.listDescendants = async () => [null]; } },
  { label: "directory fails despite live registry", active: true, configure({ services }) { services.subagents.listDescendants = async () => { throw new Error("directory unavailable"); }; } },
];

for (const approval of ["never", "ask"]) {
  for (const scenario of directions) {
    test(`${approval}: ${scenario.label} delegates without models`, async () => {
      const options = { ...scenario, approval };
      const { context } = await verifyContext(buildTrustedContext, options, true);
      assert.equal(context.messageTarget.membership, "same-tree");
      assert.equal(context.messageTarget.hostLocal, true);
      assert.equal(context.messageTarget.downstreamIndependentApproval, true);
      const fixture = createMemoryFixture(options);
      const decision = await fixture.run();
      assertServiceIdentity(fixture);
      assert.equal(decision.kind, "fixture-delegate");
      assert.equal(fixture.guard(), undefined);
      assert.equal(fixture.audits[0].mandatory.status, "safe");
      assert.equal(fixture.audits[0].pluginReturnedAction, "defer_to_host");
      assert.equal(fixture.audits[0].modelEvaluation.status, "not_requested");
      assert.deepEqual(fixture.counters, { primary: 0, fallback: 0, delegated: 1, approval: 0, globalFallback: 0 });
    });
  }
  for (const scenario of failures) {
    test(`${approval}: ${scenario.label} remains protected`, async () => {
      await verifyContext(buildTrustedContext, { ...scenario, approval }, false, false);
      const fixture = createMemoryFixture({ ...scenario, approval });
      const decision = await fixture.run();
      assert.equal(decision.kind, approval === "never" ? "deny" : "ask");
      assert.equal(fixture.audits[0].mandatory.status, "requires_approval");
      assert.ok(fixture.audits[0].mandatory.reasonCodes.includes("recipient-authority-unverified"));
      assert.equal(fixture.audits[0].modelEvaluation.status, "not_requested");
      if (scenario.guardPresent !== false) assert.equal(fixture.guard().info.code, "DECISION_ENGINE_MANDATORY_DENY");
      assert.deepEqual(fixture.counters, { primary: 0, fallback: 0, delegated: 0, approval: 0, globalFallback: 0 });
    });
  }
}

/**
 * 1.16.x 现场：mount 时 `ctx.get("tools")` 还看不到工具服务，旧实现于是
 * 永远不注册全局守卫；同树可接续消息因此被判 `recipient-authority-unverified`，
 * `approvalPolicy=never` 下被直接拒绝。下面四个用例就是这条启动/重载时序的
 * 回归矩阵：服务晚到、同一服务晚提供 guard、服务换代、换代后没有 guard。
 */
test("never: tools 服务晚于插件启动时，调用期注册 guard 仍让同树消息免审批", async () => {
  const fixture = createMemoryFixture({ approval: "never", configure({ services }) { delete services.tools; } });
  assert.equal(fixture.guardRegistrations.count, 0, "mount 时没有可注册的服务");
  fixture.replaceTools();
  const decision = await fixture.run();
  assert.equal(decision.kind, "fixture-delegate");
  assert.equal(fixture.guardRegistrations.count, 1, "第一次判定时补注册");
  assert.equal(fixture.audits[0].mandatory.status, "safe");
  assert.equal(fixture.audits[0].messageVerification.globalGuardRegistered, true);
  assert.equal(fixture.audits[0].messageVerification.verificationReason, "verified");
  assert.equal(fixture.guard(), undefined, "执行期守卫与会话裁决对齐");
});

test("never: 同一 tools 服务后来才提供 guard，调用期补注册仍算已注册", async () => {
  const fixture = createMemoryFixture({ approval: "never", guardPresent: false });
  assert.equal(fixture.guardRegistrations.count, 0);
  fixture.installToolsGuard();
  const decision = await fixture.run();
  assert.equal(decision.kind, "fixture-delegate");
  assert.equal(fixture.guardRegistrations.count, 1);
  assert.equal(fixture.audits[0].messageVerification.globalGuardRegistered, true);
});

test("never: 热重载换掉 tools 服务后重新注册，同树消息继续免审批", async () => {
  const fixture = createMemoryFixture({ approval: "never" });
  assert.equal((await fixture.run()).kind, "fixture-delegate");
  assert.equal(fixture.guardRegistrations.count, 1);
  fixture.replaceTools();
  assert.equal((await fixture.run()).kind, "fixture-delegate");
  assert.deepEqual(fixture.guardRegistrations, { count: 2, disposed: 1 }, "旧服务注册要注销，新服务重新注册");
  assert.equal(fixture.audits[1].messageVerification.globalGuardRegistered, true);
});

test("never: 换代后的 tools 服务没有 guard 时不沿用旧证据，同树消息回到需要审批", async () => {
  const fixture = createMemoryFixture({ approval: "never" });
  assert.equal((await fixture.run()).kind, "fixture-delegate");
  fixture.replaceTools({ guard: false });
  const decision = await fixture.run();
  assert.equal(decision.kind, "deny");
  assert.equal(fixture.audits[1].mandatory.status, "requires_approval");
  assert.ok(fixture.audits[1].mandatory.reasonCodes.includes("recipient-authority-unverified"));
  assert.equal(fixture.audits[1].messageVerification.globalGuardRegistered, false);
  assert.equal(fixture.audits[1].messageVerification.verificationReason, "guard-not-registered");
  assert.equal(fixture.guardRegistrations.disposed, 1);
  assert.equal(fixture.counters.delegated, 1, "只有第一次放行");
});

test("never: 始终没有 tools 服务时同树消息仍 fail-closed", async () => {
  const fixture = createMemoryFixture({ approval: "never", configure({ services }) { delete services.tools; } });
  const decision = await fixture.run();
  assert.equal(decision.kind, "deny");
  assert.ok(fixture.audits[0].mandatory.reasonCodes.includes("recipient-authority-unverified"));
  assert.equal(fixture.audits[0].messageVerification.globalGuardRegistered, false);
  assert.equal(fixture.guardRegistrations.count, 0);
  assert.equal(fixture.counters.delegated, 0);
});

test("never: guard 注册抛错时不谎报已注册，同树消息保持 fail-closed 且下次重试", async () => {
  const fixture = createMemoryFixture({ approval: "never", configure({ services }) { services.tools.guard = () => { throw new Error("fixture registration failure"); }; } });
  const decision = await fixture.run();
  assert.equal(decision.kind, "deny");
  assert.equal(fixture.audits[0].messageVerification.globalGuardRegistered, false);
  assert.equal(fixture.audits[0].messageVerification.verificationReason, "guard-not-registered");
});

test("observe: 即使工具侧已注册 guard，也不把它当作下游独立批准证据", async () => {
  const fixture = createMemoryFixture({ approval: "never", config: { guardPolicyMode: "observe" } });
  await fixture.run();
  assert.equal(fixture.audits[0].mandatory.status, "requires_approval");
  assert.equal(fixture.audits[0].messageVerification.globalGuardRegistered, false);
  assert.equal(fixture.audits[0].messageVerification.downstreamIndependentApproval, "unknown");
});

function approvalEvents(exec, { outcome = "allowed-once", callId = exec.callId, toolName = exec.name, askedSeq = 2, decidedSeq = 3, id = "memory-approval" } = {}) {
  return [
    { type: "approval/asked", seq: askedSeq, data: { id, callId, toolName } },
    { type: "approval/decided", seq: decidedSeq, data: { id, outcome } },
  ];
}

const unverifiedOptions = { approval: "ask", configure({ services }) { services.subagents.listDescendants = async () => []; } };

for (const outcome of ["allowed-once", "rejected", "cancelled", "unavailable"]) {
  test(`ask: only native allowed-once passes the execution guard (${outcome})`, async () => {
    const fixture = createMemoryFixture(unverifiedOptions);
    assert.equal((await fixture.run()).kind, "ask");
    assert.equal(fixture.guard().info.code, "DECISION_ENGINE_MANDATORY_DENY");
    fixture.events.push(...approvalEvents(fixture.exec, { outcome }));
    if (outcome === "allowed-once") assert.equal(fixture.guard(), undefined);
    else assert.equal(fixture.guard().info.code, "DECISION_ENGINE_MANDATORY_DENY");
    assert.equal(fixture.counters.delegated, 0);
    assert.equal(fixture.counters.approval, 0);
  });
}

for (const scenario of [
  { label: "different call", options: { callId: "other-call" } },
  { label: "different tool", options: { toolName: "other-tool" } },
  { label: "asked before review", options: { askedSeq: 0, decidedSeq: 3 } },
  { label: "decided before asked", options: { askedSeq: 3, decidedSeq: 2 } },
]) {
  test(`ask: ${scenario.label} cannot approve this message`, async () => {
    const fixture = createMemoryFixture(unverifiedOptions);
    await fixture.run();
    fixture.events.push(...approvalEvents(fixture.exec, scenario.options));
    assert.equal(fixture.guard().info.code, "DECISION_ENGINE_MANDATORY_DENY");
  });
}

test("ask: old approval and user text cannot replace a post-review decision", async () => {
  const fixture = createMemoryFixture(unverifiedOptions);
  fixture.events.push(...approvalEvents(fixture.exec));
  fixture.events.push({ type: "user/message", seq: 4, data: { source: { kind: "user" }, content: [{ type: "text", text: "I approve this fixture message." }] } });
  assert.equal((await fixture.run()).kind, "ask");
  assert.equal(fixture.guard().info.code, "DECISION_ENGINE_MANDATORY_DENY");
  fixture.events.push(...approvalEvents(fixture.exec, { askedSeq: 5, decidedSeq: 6, id: "new-memory-approval" }));
  assert.equal(fixture.guard(), undefined);
});

for (const scenario of [
  { label: "call", change: (exec) => ({ ...exec, callId: "changed-call" }) },
  { label: "token", change: (exec) => ({ ...exec, token: Symbol("changed-token") }), code: "DECISION_ENGINE_MISSING_REVIEW" },
  { label: "tool", change: (exec) => ({ ...exec, name: "other-tool" }) },
  { label: "message args", change: (exec) => ({ ...exec, arguments: { ...exec.arguments, message: "changed fixture content" } }) },
  { label: "target args", change: (exec) => ({ ...exec, arguments: { ...exec.arguments, agent: "other-fixture-target" } }) },
  { label: "session", change: (exec) => ({ ...exec, agent: { ...exec.agent, session: { ...exec.agent.session, id: "other-session" } } }) },
]) {
  test(`ask: approved message rejects changed ${scenario.label}`, async () => {
    const fixture = createMemoryFixture(unverifiedOptions);
    await fixture.run();
    fixture.events.push(...approvalEvents(fixture.exec));
    assert.equal(fixture.guard(), undefined);
    assert.equal(fixture.guard(scenario.change(fixture.exec)).info.code, scenario.code ?? "DECISION_ENGINE_REVIEW_CHANGED");
    assert.equal(fixture.counters.delegated, 0);
  });
}

/**
 * 把 context.js 源码放进 data: URL 里执行时，相对 import 无法解析。
 * 只把相对依赖改写成绝对 file: URL，其余源码原样保留——这里的断言针对的是
 * 被改写的验证逻辑，而不是模块解析行为。
 */
async function importContextSource(source) {
  const effectsUrl = new URL("../lib/guard/effects.js", import.meta.url).href;
  const resolved = source.replaceAll('from "./effects.js"', `from ${JSON.stringify(effectsUrl)}`);
  assert.ok(!resolved.includes('from "./effects.js"'), "relative import must be rewritten for data: URL");
  return import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
}

test("in-memory root-directory mutation fails the same context verifier", async () => {
  const source = await readFile(new URL("../lib/guard/context.js", import.meta.url), "utf8");
  const original = "subagents.listDescendants(rootId, exec.signal)";
  assert.ok(source.includes(original), "mutation anchor must exist");
  const mutated = source.replace(original, "subagents.listDescendants(agent.session.id, exec.signal)");
  const { buildTrustedContext: alteredBuild } = await importContextSource(mutated);
  const options = { sender: "child", target: "sibling", active: false };
  await verifyContext(buildTrustedContext, options, true);
  await assert.rejects(() => verifyContext(alteredBuild, options, true), { code: "ERR_ASSERTION" });
  await assert.rejects(() => verifyContext(alteredBuild, options, true, false), { code: "ERR_ASSERTION" });
});

test("in-memory resolve-only mutation fails the same recipient verifier", async () => {
  const source = await readFile(new URL("../lib/guard/context.js", import.meta.url), "utf8");
  const original = "const verified = targetId === rootId || Boolean(member);";
  assert.ok(source.includes(original), "mutation anchor must exist");
  const mutated = source.replace(original, "const verified = Boolean(targetId);");
  const { buildTrustedContext: alteredBuild } = await importContextSource(mutated);
  const options = failures[0];
  await verifyContext(buildTrustedContext, options, false, false);
  await assert.rejects(() => verifyContext(alteredBuild, options, false, false), { code: "ERR_ASSERTION" });
});
