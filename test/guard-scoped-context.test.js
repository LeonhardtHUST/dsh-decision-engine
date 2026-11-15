import test from "node:test";
import assert from "node:assert/strict";
import { buildTrustedContext, guardService } from "../lib/guard/context.js";

function userSession(id = "scoped-session") {
  return { id, snapshotEvents: () => [] };
}

function baseAgent(actorServices) {
  return { id: "actor-agent", session: userSession(), ctx: { get: (name) => actorServices[name] } };
}

function rootServices(rootServices, actorServices, serviceFor = () => undefined) {
  const presets = { composedPreset: () => "fixture-isolated-preset", serviceFor(agent, name) { assert.equal(agent.ctx?.get?.("permissionPresets"), actorServices.permissionPresets); return serviceFor(agent, name); } };
  return {
    get(name) { return name === "agentPresets" ? presets : rootServices[name]; },
  };
}

test("isolated preset serviceFor beats agent ctx getter still exposing global realm", async () => {
  const globalServices = {
    permissionPresets: { current: () => "auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: "C:/global-workspace" }) },
  };
  const isolatedServices = {
    permissionPresets: { current: () => "isolated-manual", resolve: () => ({ approval: "ask", sandbox: "read-only" }) },
    approval: { overrideOf: () => "ask", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "read-only", workspaceRoot: "C:/isolated-workspace" }) },
  };
  const agent = baseAgent(globalServices);
  const registry = {
    composedPreset(actorContext) { assert.equal(actorContext, agent.ctx); return "isolated-composition"; },
    serviceFor(actor, name) { assert.equal(actor, agent); return isolatedServices[name]; },
  };
  const context = await buildTrustedContext({ agent, ctx: { get: (name) => name === "agentPresets" ? registry : globalServices[name] } });
  assert.equal(context.permissionPreset, "isolated-manual");
  assert.equal(context.approvalPolicy, "ask");
  assert.equal(context.sandboxMode, "read-only");
  assert.deepEqual(context.workspaceRoots, ["C:/isolated-workspace"]);
});

test("bound preset missing override uses actor baseline like native serviceFor consumers", async () => {
  const globalServices = {
    permissionPresets: { current: () => "auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: "C:/global-workspace" }) },
  };
  const registry = { composedPreset: () => "isolated-without-services", serviceFor: () => undefined };
  const context = await buildTrustedContext({ agent: baseAgent(globalServices), ctx: { get: (name) => name === "agentPresets" ? registry : globalServices[name] } });
  assert.equal(context.permissionPreset, "auto");
  assert.equal(context.approvalPolicy, "never");
  assert.equal(context.sandboxMode, "danger-full-access");
  assert.deepEqual(context.workspaceRoots, ["C:/global-workspace"]);
  assert.equal(context.serviceSources.permissionPresets, "actor-host");
});

test("agent scoped services take precedence over root permission and sandbox services", async () => {
  const actorServices = {
    permissionPresets: { current: () => "actor-preset", resolve: () => ({ approval: "ask", sandbox: "workspace-write" }) },
    approval: { overrideOf: () => "ask", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "C:/actor-workspace" }) },
  };
  const root = {
    permissionPresets: { current: () => "root-auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never" },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: "C:/root-workspace" }) },
  };
  const agent = baseAgent(actorServices);
  const context = await buildTrustedContext({ agent, ctx: rootServices(root, actorServices, (_agent, name) => actorServices[name]) });
  assert.equal(context.permissionPreset, "actor-preset");
  assert.equal(context.approvalPolicy, "ask");
  assert.equal(context.approvalAvailable, true);
  assert.equal(context.sandboxMode, "workspace-write");
  assert.deepEqual(context.workspaceRoots, ["C:/actor-workspace"]);
});

test("missing actor-scoped service does not fall back to a broader root service", async () => {
  const actorServices = { permissionPresets: undefined, approval: undefined, sandboxPolicy: undefined };
  const root = {
    permissionPresets: { current: () => "root-auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never" },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: "C:/root-workspace" }) },
  };
  const context = await buildTrustedContext({
    agent: baseAgent(actorServices),
    ctx: rootServices(root, actorServices),
  });
  assert.equal(context.permissionPreset, "unknown");
  assert.equal(context.approvalPolicy, "unknown");
  assert.equal(context.approvalAvailable, "unknown");
  assert.equal(context.sandboxMode, "unknown");
  assert.deepEqual(context.workspaceRoots, []);
});

test("actor scoped service failure remains unknown instead of widening to root", async () => {
  const actorServices = {
    permissionPresets: { current: () => { throw new Error("actor unavailable"); } },
    approval: { overrideOf: () => { throw new Error("actor unavailable"); } },
    sandboxPolicy: { resolve: () => { throw new Error("actor unavailable"); } },
  };
  const root = {
    permissionPresets: { current: () => "root-auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never" },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access", workspaceRoot: "C:/root-workspace" }) },
  };
  const context = await buildTrustedContext({ agent: baseAgent(actorServices), ctx: rootServices(root, actorServices, (_agent, name) => actorServices[name]) });
  assert.equal(context.permissionPreset, "unknown");
  assert.equal(context.approvalPolicy, "unknown");
  assert.equal(context.approvalAvailable, "unknown");
  assert.equal(context.sandboxMode, "unknown");
  assert.deepEqual(context.workspaceRoots, []);
});

test("actor tools executable returning undefined is authoritative denial, not root allowance", async () => {
  const actorServices = {
    tools: { executable(_name, scope, toolSet) { assert.equal(scope, agent); assert.equal(toolSet, "actor-admitted-set"); return undefined; } },
  };
  const root = { tools: { executable: () => ({ name: "fixture-tool" }) } };
  const agent = baseAgent(actorServices);
  const context = await buildTrustedContext({ agent, ctx: rootServices(root, actorServices, (_agent, name) => actorServices[name]), exec: { name: "fixture-tool", arguments: {}, toolSet: "actor-admitted-set" } });
  assert.equal(context.toolAccess, "denied");
});

test("actor never is an approval policy, not evidence for Auto preset", async () => {
  const actorServices = {
    permissionPresets: { current: () => "restricted-manual", resolve: () => ({ approval: "never", sandbox: "read-only" }) },
    approval: { overrideOf: () => "never", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "read-only", workspaceRoot: "C:/actor-workspace" }) },
  };
  const root = {
    permissionPresets: { current: () => "auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
    approval: { overrideOf: () => "never", request() {} },
  };
  const context = await buildTrustedContext({ agent: baseAgent(actorServices), ctx: rootServices(root, actorServices, (_agent, name) => actorServices[name]) });
  assert.equal(context.permissionPreset, "restricted-manual");
  assert.notEqual(context.permissionPreset, "auto");
  assert.equal(context.approvalPolicy, "never");
  assert.equal(context.approvalAvailable, false);
  assert.equal(context.sandboxMode, "read-only");
  assert.equal(context.delegatedScope, "unknown");
  assert.equal(context.targetPermissions, "unknown");
});

test("unbound actor context supplies services without borrowing root defaults", async () => {
  const actorServices = {
    permissionPresets: { current: () => "unbound-actor", resolve: () => ({ approval: "ask", sandbox: "read-only" }) },
    approval: { overrideOf: () => "ask", request() {} },
  };
  const root = {
    agentPresets: { composedPreset: () => undefined, serviceFor: () => undefined },
    permissionPresets: { current: () => "auto", resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) },
  };
  const context = await buildTrustedContext({ agent: baseAgent(actorServices), ctx: { get: (name) => root[name] } });
  assert.equal(context.permissionPreset, "unbound-actor");
  assert.equal(context.approvalPolicy, "ask");
  assert.equal(context.sandboxMode, "read-only");
});

test("specific preset current returning undefined does not retry actor or root preset", async () => {
  let baselineCalls = 0;
  const baseline = { permissionPresets: { current() { baselineCalls += 1; return "auto"; }, resolve: () => ({ approval: "never", sandbox: "danger-full-access" }) } };
  const override = { current: () => undefined, resolve() { throw new Error("missing preset must not resolve"); } };
  const registry = { serviceFor: (_agent, name) => name === "permissionPresets" ? override : undefined };
  const context = await buildTrustedContext({ agent: baseAgent(baseline), ctx: { get: (name) => name === "agentPresets" ? registry : baseline[name] } });
  assert.equal(context.permissionPreset, "unknown");
  assert.equal(context.serviceSources.permissionPresets, "preset");
  assert.equal(baselineCalls, 0);
});

test("specific preset executable undefined remains denied despite wider actor baseline", async () => {
  let baselineCalls = 0;
  const baseline = { tools: { executable() { baselineCalls += 1; return { name: "fixture-tool" }; } } };
  const override = { executable: () => undefined };
  const registry = { serviceFor: (_agent, name) => name === "tools" ? override : undefined };
  const context = await buildTrustedContext({ agent: baseAgent(baseline), ctx: { get: (name) => name === "agentPresets" ? registry : baseline[name] }, exec: { name: "fixture-tool", arguments: {} } });
  assert.equal(context.toolAccess, "denied");
  assert.equal(context.serviceSources.tools, "preset");
  assert.equal(baselineCalls, 0);
});

test("absent preset llm override retains actor shared llm without borrowing a different root", () => {
  const actorLlm = { stream() {} };
  const rootLlm = { stream() { throw new Error("wrong root llm"); } };
  const registry = { serviceFor: () => undefined };
  const sources = {};
  const result = guardService({ get: (name) => name === "agentPresets" ? registry : name === "llm" ? rootLlm : undefined }, baseAgent({ llm: actorLlm }), "llm", sources);
  assert.equal(result, actorLlm);
  assert.equal(sources.llm, "actor-host");
});

test("serviceFor query failure does not masquerade as absent override", () => {
  const registry = { serviceFor() { throw new Error("preset lookup unavailable"); } };
  const sources = {};
  const result = guardService({ get: (name) => name === "agentPresets" ? registry : undefined }, baseAgent({ llm: { stream() {} } }), "llm", sources);
  assert.equal(result, undefined);
  assert.equal(sources.llm, "preset-error");
});

test("actor getter throwing or missing baseline never retries a broader root", () => {
  for (const get of [() => undefined, () => { throw new Error("actor unavailable"); }]) {
    let rootCalls = 0;
    const ctx = { get(name) { if (name === "agentPresets") return { serviceFor: () => undefined }; rootCalls += 1; return { stream() {} }; } };
    assert.equal(guardService(ctx, { ctx: { get } }, "llm"), undefined);
    assert.equal(rootCalls, 0);
  }
});

test("root context remains compatible when actor context and preset resolver are absent", async () => {
  const root = {
    permissionPresets: { current: () => "root-preset", resolve: () => ({ approval: "ask", sandbox: "read-only" }) },
    approval: { overrideOf: () => "ask", request() {} },
    sandboxPolicy: { resolve: () => ({ mode: "read-only", workspaceRoot: "C:/root-workspace" }) },
  };
  const agent = { id: "root-agent", session: userSession() };
  const context = await buildTrustedContext({ agent, ctx: { get: (name) => root[name] } });
  assert.equal(context.permissionPreset, "root-preset");
  assert.equal(context.approvalPolicy, "ask");
  assert.equal(context.sandboxMode, "read-only");
});
