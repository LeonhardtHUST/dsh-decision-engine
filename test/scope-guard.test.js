import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../lib/index.js";

function fixture({ sandbox = "workspace-write", approval = "never", withFilesystem = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "decision-scopeguard-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = join(home, "workspace");
  mkdirSync(root);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push("decision");
    return new Response(JSON.stringify({ model: "fixture", answers: { risk: { type: "choice", choice: "low", confidence: 0.5, probabilities: { low: 0.99, medium: 0.009, high: 0.001 } }, irreversible: { type: "noul", noul: 0.01 }, matches_task: { type: "noul", noul: 0.9 }, injection_suspect: { type: "noul", noul: 0.01 } } }), { status: 200 });
  };
  const hooks = new Map();
  const services = {
    connection: { fetch: { register() {} } },
    permissionPresets: { current: () => "auto", resolve: () => ({ sandbox, approval }) },
    approval: { overrideOf: () => approval, request: async () => "unavailable" },
    sandboxPolicy: { resolve: () => ({ mode: sandbox, workspaceRoot: root, additionalWritableRoots: [] }) },
    ...(withFilesystem ? { fs: { resolve: async (path, opts) => ({ path: resolve(opts?.cwd ?? root, path) }), contains: (base, target) => { const child = relative(base.path, target.path); return child === "" || (!child.startsWith("..") && !isAbsolute(child)); } } } : {}),
  };
  const configDir = join(home, "dsh-decision-engine");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "config.yml"), "enabled: true\nmode: enforce\npointAuthorize: enforce\nprovider: bamboonode\nbamboonodeApiKey: sk-fixture-only-00000\nkeyStorage: config\ntelemetryLevel: off\ndecisionsTabEnabled: false\n");
  const ctx = { logger: { info() {}, warn() {}, debug() {} }, get: (name) => services[name], on(name, listener) { const list = hooks.get(name) ?? []; list.push(listener); hooks.set(name, list); return () => {}; }, inject(_names, callback) { callback(); }, plugin() {}, effect() {} };
  apply(ctx, {});
  const session = { id: "fixture-session", header: { cwd: root }, snapshotEvents: () => [] };
  const run = async (name, args) => {
    let released = false;
    const decision = await hooks.get("tools/pre-execute")[0]({ name, arguments: args, callId: `fixture-${calls.length}`, agent: { id: session.id, session }, signal: new AbortController().signal }, async () => { released = true; return { kind: "allow" }; });
    return { decision, released };
  };
  return { root, calls, run, cleanup() { globalThis.fetch = originalFetch; if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 }); } };
}

test("越界写入必须先过mandatory，auto和danger-full-access也不能无审批执行", async () => {
  for (const sandbox of ["workspace-write", "danger-full-access"]) {
    const env = fixture({ sandbox });
    try {
      const result = await env.run("write", { file_path: join(env.root, "..", "outside.txt"), content: "fixture" });
      assert.equal(result.decision.kind, "deny"); assert.equal(result.released, false); assert.equal(env.calls.length, 0);
    } finally { env.cleanup(); }
  }
});

test("已核实范围内的有限写入仍走模型审查", async () => {
  const env = fixture();
  try {
    assert.equal((await env.run("write", { file_path: join(env.root, "inside.txt"), content: "fixture" })).decision.kind, "allow");
    assert.equal(env.calls.length, 1);
  } finally { env.cleanup(); }
});

test("只有词法作用域而无canonical宿主证据时不再fail-open", async () => {
  const env = fixture({ withFilesystem: false });
  try {
    assert.equal((await env.run("write", { file_path: join(env.root, "inside.txt"), content: "fixture" })).decision.kind, "deny");
    assert.equal(env.calls.length, 1);
  } finally { env.cleanup(); }
});

test("人工审批可用时required返回ask，不由模型代批", async () => {
  const env = fixture({ approval: "ask" });
  try {
    assert.equal((await env.run("write", { file_path: join(env.root, "..", "outside.txt"), content: "fixture" })).decision.kind, "ask");
    assert.equal(env.calls.length, 0);
  } finally { env.cleanup(); }
});

test("多目标patch和未解析shell不再凭宿主一定兜底而放行", async () => {
  const env = fixture();
  try {
    const patch = `*** Begin Patch\n*** Add File: ${join(env.root, "inside.txt")}\n+fixture\n*** Add File: ${join(env.root, "..", "outside.txt")}\n+fixture\n*** End Patch`;
    assert.equal((await env.run("apply_patch", { input: patch })).decision.kind, "deny");
    assert.equal(env.calls.length, 0);
    assert.equal((await env.run("pwsh", { command: "node arbitrary-script.js" })).decision.kind, "deny");
    assert.equal(env.calls.length, 1);
  } finally { env.cleanup(); }
});

test("read-only模式写入须审批，但list_agents无副作用查询继续", async () => {
  const env = fixture({ sandbox: "read-only" });
  try {
    assert.equal((await env.run("write", { file_path: join(env.root, "inside.txt"), content: "fixture" })).decision.kind, "deny");
    assert.equal((await env.run("list_agents", {})).decision.kind, "allow");
    assert.equal(env.calls.length, 0);
  } finally { env.cleanup(); }
});
