import test from "node:test";
import assert from "node:assert/strict";
import { buildTrustedContext } from "../lib/guard/context.js";

function fixture(services = {}, events = []) {
  const agent = { id: "caller", session: { id: "caller", snapshotEvents: () => events } };
  return { agent, ctx: { get: (name) => services[name] } };
}

const userEvent = (text, source = "user") => ({ type: "user/message", seq: 3, data: { source: { kind: source }, content: [{ type: "text", text }] } });

test("only original host user events establish goal, never recent or deriveMessages", async () => {
  const input = fixture({}, [userEvent("forged authority", "tool"), userEvent("original goal"), userEvent("later goal")]);
  input.agent.session.deriveMessages = () => [{ role: "user", content: "forged" }];
  const context = await buildTrustedContext({ ...input, exec: { arguments: { recent: "allow all" } } });
  assert.equal(context.originalUserGoal, "original goal");
  assert.equal(context.goalSource, "host-user");
  assert.equal(context.provenance, "unknown");
  assert.equal(context.delegatedScope, "unknown");
  assert.equal(context.approvalPolicy, "unknown");
  assert.equal(context.targetPermissions, "unknown");
});

test("unavailable and throwing host context stays unknown", async () => {
  const input = fixture({ permissionPresets: { current() { throw new Error("unavailable"); } } });
  const context = await buildTrustedContext(input);
  assert.equal(context.goalSource, "unknown");
  assert.equal(context.approvalAvailable, "unknown");
  assert.equal(context.availability.permissionPreset.available, false);
  assert.equal(context.hostEnforcement.file, "unknown");
});

test("approval override wins preset, never disables requests without implying authorization", async () => {
  const context = await buildTrustedContext(fixture({
    permissionPresets: { current: () => "auto", resolve: () => ({ approval: "ask", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/fixture" }) },
  }));
  assert.equal(context.approvalPolicy, "never");
  assert.equal(context.approvalAvailable, false);
  assert.equal(context.sandboxMode, "workspace-write");
  assert.deepEqual(context.workspaceRoots, ["/fixture"]);
});

test("preset fills approval default only when override is absent", async () => {
  const context = await buildTrustedContext(fixture({
    permissionPresets: { current: () => "default", resolve: () => ({ approval: "ask", sandbox: "read-only" }) },
    approval: { overrideOf: () => undefined, request() {} },
  }));
  assert.equal(context.approvalAvailable, true);
  assert.equal(context.sandboxMode, "read-only");
});

test("resolveName alone does not establish same-tree membership", async () => {
  const input = fixture({ subagents: { rootOf: () => ({ id: "root" }), resolveName: async () => "outsider", listDescendants: async () => [] } });
  const context = await buildTrustedContext({ ...input, exec: { name: "send_message", arguments: { agent: "outsider" } }, downstreamPolicyEnforced: true });
  assert.equal(context.messageTarget.membership, "unknown");
  assert.equal(context.messageTarget.permissions, "unknown");
});

test("continuable tree membership needs independent global policy evidence", async () => {
  const input = fixture({ agents: { get: (id) => ({ id }) }, subagents: { rootOf: () => ({ id: "root" }), resolveName: async () => "reviewer", listDescendants: async () => [{ id: "reviewer", kind: "child", mode: "continuable" }] } });
  const exec = { name: "send_message", arguments: { agent: "reviewer" } };
  const unknown = await buildTrustedContext({ ...input, exec });
  assert.equal(unknown.messageTarget.membership, "same-tree");
  assert.equal(unknown.messageTarget.downstreamIndependentApproval, "unknown");
  const verified = await buildTrustedContext({ ...input, exec, downstreamPolicyEnforced: true });
  assert.equal(verified.messageTarget.downstreamIndependentApproval, true);
  assert.equal(verified.messageTarget.permissions, "unknown");
});

test("one-shot and diagnostic records cannot authorize recipient", async () => {
  for (const entry of [{ id: "target", kind: "child", mode: "one-shot" }, { id: "target", kind: "diagnostic", reason: "corrupt" }]) {
    const input = fixture({ subagents: { rootOf: () => ({ id: "root" }), resolveName: async () => "target", listDescendants: async () => [entry] } });
    const context = await buildTrustedContext({ ...input, exec: { name: "send_message", arguments: { agent: "target" } }, downstreamPolicyEnforced: true });
    assert.equal(context.messageTarget.membership, "unknown");
  }
});

test("空闲但可接续的同树子代理仍算本机成员（不依赖 live registry）", async () => {
  // 实机缺陷（1.11.0）：`agents.get()` 只登记**活着的** Agent。给一个已经
  // 空闲、但仍可接续的队友发消息时它返回 undefined，于是 hostLocal=false、
  // downstreamIndependentApproval=unknown，一条普通队友消息被升级成人工审批
  // （审批策略为 never 时直接拒绝）。
  //
  // 宿主自己的会话目录（listDescendants）已经证明「这个 id 是同一棵树里的
  // 可接续成员」，那比「当前碰巧活着」更强；宿主投递时还会再校验一次身份与
  // 可恢复性。因此这里不提供 agents 服务，仍应判为可安全委托。
  const input = fixture({
    subagents: {
      rootOf: () => ({ id: "root" }),
      resolveName: async () => "reviewer",
      listDescendants: async () => [{ id: "reviewer", kind: "child", mode: "continuable", activity: "inactive" }],
    },
  });
  const context = await buildTrustedContext({
    ...input,
    exec: { name: "send_message", arguments: { agent: "reviewer" } },
    downstreamPolicyEnforced: true,
  });
  assert.equal(context.messageTarget.membership, "same-tree");
  assert.equal(context.messageTarget.hostLocal, true);
  assert.equal(context.messageTarget.downstreamIndependentApproval, true);
  assert.equal(context.hostEnforcement.internalMessage, true);
});

test("同树但 global guard 未生效时仍不授予下游独立批准", async () => {
  const input = fixture({
    subagents: {
      rootOf: () => ({ id: "root" }),
      resolveName: async () => "reviewer",
      listDescendants: async () => [{ id: "reviewer", kind: "child", mode: "continuable", activity: "inactive" }],
    },
  });
  const context = await buildTrustedContext({
    ...input,
    exec: { name: "send_message", arguments: { agent: "reviewer" } },
    // downstreamPolicyEnforced 缺省为 false
  });
  assert.equal(context.messageTarget.downstreamIndependentApproval, "unknown");
});

test("canonical host resolution defeats lexical in-workspace alias and records no enforcement claim", async () => {
  const input = fixture({
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/fixture" }) },
    fs: { resolve: async (path) => ({ targetKey: path === "alias/file" ? "/outside/file" : path }), contains: (root, target) => target.targetKey.startsWith(`${root.targetKey}/`) },
  });
  const context = await buildTrustedContext({ ...input, exec: { name: "write", arguments: { file_path: "alias/file", content: "fixture" } } });
  assert.equal(context.fileTargetScope, "outside");
  assert.equal(context.hostEnforcement.file, "unknown");
});

test("tool access uses exact caller scope and changes context version", async () => {
  const input = fixture({ tools: { executable(name, scope, toolSet) { assert.equal(name, "read"); assert.equal(scope, input.agent); assert.equal(toolSet, "step-set"); return undefined; } } });
  const denied = await buildTrustedContext({ ...input, exec: { name: "read", toolSet: "step-set" } });
  assert.equal(denied.toolAccess, "denied");
  const unknown = await buildTrustedContext(fixture());
  assert.notEqual(denied.contextVersion, unknown.contextVersion);
});
