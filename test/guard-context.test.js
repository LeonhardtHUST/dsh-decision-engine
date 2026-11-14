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
