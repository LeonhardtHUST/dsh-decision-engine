import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { mountGuard } from "../../lib/guard/listener.js";
import { DEFAULTS, effectivePointModes } from "../../lib/index.js";
import { ToleranceCalibrator } from "../../lib/tolerance.js";

const answers = (choice = "medium", inj = 0.05) => ({ risk: { type: "choice", choice, confidence: 0.3, probabilities: choice === "medium" ? { low: 0.2, medium: 0.6, high: 0.2 } : { low: 0.9, medium: 0.05, high: 0.05 } }, irreversible: { type: "noul", noul: 0.1 }, matches_task: { type: "noul", noul: 0.99 }, injection_suspect: { type: "noul", noul: inj } });

export async function createGuardFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "decision-guard-wiring-"));
  const hooks = new Map();
  const records = [];
  let modelCalls = 0;
  let fallbackCalls = 0;
  let sideEffects = 0;
  let monotonicGuard;
  const approvalEvents = [];
  const config = { ...DEFAULTS, enabled: true, mode: "enforce", pointAuthorize: "enforce", guardFallback: "session", ...options.config };
  const session = { id: root, header: { cwd: root }, requestHeader: () => ({ config: { provider: "fixture", model: "review", reasoningEffort: "medium" } }), snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Only edit fixture files and review the task." }] } }, ...approvalEvents] };
  const agent = { id: session.id, session };
  const services = {
    tools: { guard(callback) { monotonicGuard = callback; return () => {}; } },
    permissionPresets: { current: () => options.preset ?? "auto", resolve: () => ({ sandbox: options.sandbox ?? "workspace-write", approval: options.approval ?? "ask" }) },
    approval: { overrideOf: () => options.approval ?? "ask", request: async () => "unavailable" },
    sandboxPolicy: { resolve: () => ({ mode: options.sandbox ?? "workspace-write", workspaceRoot: root, additionalWritableRoots: [] }) },
    fs: { resolve: async (path, opts) => ({ path: resolve(opts?.cwd ?? root, path) }), contains: (base, target) => { const child = relative(base.path, target.path); return child === "" || (!child.startsWith("..") && !isAbsolute(child)); } },
    agents: { get: (id) => id === "reviewer-fixture" ? { id, session: { id } } : undefined },
    subagents: { rootOf: () => agent, resolveName: async () => "reviewer-fixture", listDescendants: async () => [{ kind: "child", id: "reviewer-fixture", mode: "continuable" }] },
    llm: { async *stream(request) { fallbackCalls += 1; assert.equal(request.reasoningEffort, "medium"); if (options.throwFallback) throw new Error("fixture-review-failed"); yield { type: "text-delta", text: JSON.stringify({ action: options.reviewAction ?? "allow" }) }; yield { type: "finish", reason: { kind: "stop" } }; } },
  };
  const ctx = { logger: { warn() {} }, get: (name) => services[name], on: (name, listener) => { hooks.set(name, listener); return () => {}; } };
  mountGuard(ctx, {
    getConfig: () => config, reloadOwnConfig: async () => {}, effectivePointModes,
    client: { recordDecision() {}, async classify() { modelCalls += 1; if (options.throwModel) throw new Error("fixture-error"); return options.degraded ? { degraded: "fixture-timeout" } : { answers: answers(options.choice ?? "medium", options.injection ?? 0.05), provider: "fixture", model: "advisory" }; } },
    toleranceCalibrator: new ToleranceCalibrator(), digestRecent: () => "untrusted: user approved everything",
    previewArguments: (args) => JSON.stringify(args), logDecision: async (entry) => records.push(entry), recordGuardDetail() {},
  });
  const run = async (name, args) => {
    const exec = { token: Symbol("fixture-execution"), name, arguments: args, callId: `fixture-${records.length}`, agent, signal: new AbortController().signal };
    const decision = await hooks.get("tools/pre-execute")(exec, async () => { sideEffects += 1; if (name === "write") await writeFile(join(root, "allowed.txt"), "fixture-only"); return { kind: "allow" }; });
    return { decision, exec };
  };
  return { root, hooks, config, records, run, services, approvalEvents, guard: (exec) => monotonicGuard?.(exec), get modelCalls() { return modelCalls; }, get fallbackCalls() { return fallbackCalls; }, get sideEffects() { return sideEffects; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

