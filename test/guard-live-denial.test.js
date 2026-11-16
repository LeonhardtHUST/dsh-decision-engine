import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mountGuard } from "../lib/guard/listener.js";
import { parseModelAdvisory, decideModelAdvisory } from "../lib/guard/advisory.js";
import { effectivePointModes } from "../lib/index.js";
import { severityOf, ToleranceCalibrator } from "../lib/tolerance.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const signals = (choice = "low", probabilities) => ({
  risk: { type: "choice", choice, confidence: 0.9, ...(probabilities === undefined ? {} : { probabilities }) },
  irreversible: { type: "noul", noul: 0.05 },
  matches_task: { type: "noul", noul: 0.99 },
  injection_suspect: { type: "noul", noul: 0.01 },
});

async function denialFixture(options = {}) {
  const fixture = await createGuardFixture({ preset: options.preset ?? "manual", approval: options.approval ?? "never", sandbox: options.sandbox, config: { tolerance: "relaxed", guardFallback: options.fallback ?? "session" } });
  const records = [];
  const details = [];
  const hooks = new Map();
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let executions = 0;
  const session = {
    id: fixture.root, header: { cwd: fixture.root },
    requestHeader: () => ({ config: { provider: "fixture-review", model: "fixture-secondary", reasoningEffort: "medium" } }),
    snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Inspect and update isolated fixture resources only." }] } }],
  };
  if (options.hostDenied) fixture.services.tools.executable = () => undefined;
  fixture.services.llm = { async *stream(request) {
    fallbackCalls += 1;
    assert.deepEqual(request.tools, []);
    yield { type: "text-delta", text: JSON.stringify({ action: options.reviewAction ?? "allow" }) };
    yield { type: "finish", reason: { kind: "stop" } };
  } };
  mountGuard({ get: (name) => fixture.services[name], on: (name, callback) => hooks.set(name, callback), logger: { warn() {} } }, {
    getConfig: () => fixture.config, reloadOwnConfig: async () => {}, effectivePointModes,
    client: { recordDecision() {}, async classify() {
      primaryCalls += 1;
      return { provider: "fixture-decision", model: "fixture-primary", answers: options.answers ?? signals() };
    } },
    toleranceCalibrator: new ToleranceCalibrator(), digestRecent: () => "isolated fixture context",
    previewArguments: (args) => JSON.stringify(args), logDecision: async (entry) => records.push(entry), recordGuardDetail: (entry) => details.push(entry),
  });
  return {
    root: fixture.root, records, details, cleanup: fixture.cleanup,
    get primaryCalls() { return primaryCalls; }, get fallbackCalls() { return fallbackCalls; }, get executions() { return executions; },
    async run(name, args) {
      const exec = { name, arguments: args, callId: `fixture-call-${records.length}`, token: Symbol("fixture"), agent: { id: session.id, session }, signal: new AbortController().signal };
      const decision = await hooks.get("tools/pre-execute")(exec, async () => { executions += 1; return { kind: "allow" }; });
      return { decision, exec, downstream: () => fixture.guard(exec) };
    },
  };
}

for (const choice of ["low", "medium"]) {
  for (const approval of ["never", "ask"]) {
    for (const toolName of ["mcp__fixture__query", "opaque_fixture_tool", "web_fetch"]) {
      test(`manual/${approval}/relaxed respects ${choice} primary and tolerance for ${toolName}`, async () => {
        const fixture = await denialFixture({ approval, answers: signals(choice) });
        try {
          const { decision, downstream } = await fixture.run(toolName, { query: "fixture" });
          assert.equal(fixture.primaryCalls, 1);
          assert.equal(fixture.fallbackCalls, 0);
          assert.equal(fixture.records[0].audit.mandatory.status, "unknown");
          assert.equal(fixture.records[0].audit.baseAction, choice === "low" ? "delegate" : "ask");
          assert.equal(decision.kind, "allow", "unknown is uncertainty, not an unconditional veto after successful review");
          assert.equal(fixture.executions, 1);
          assert.equal(downstream(), undefined);
          assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "completed");
          assert.equal(fixture.details[0].scores.modelEvaluation.fallback.status, "not_requested");
          assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
        } finally { await fixture.cleanup(); }
      });
    }
  }
}

for (const choice of ["low", "medium"]) {
  for (const reviewAction of ["allow", "deny"]) {
    test(`Auto uncertainty still uses independent LLM for ${choice}, returning ${reviewAction}`, async () => {
      const fixture = await denialFixture({ preset: "auto", answers: signals(choice), reviewAction });
      try {
        const { decision } = await fixture.run("mcp__fixture__query", { query: "fixture" });
        assert.equal(fixture.primaryCalls, 1);
        assert.equal(fixture.fallbackCalls, 1);
        assert.equal(decision.kind, reviewAction);
        assert.equal(fixture.executions, reviewAction === "allow" ? 1 : 0);
        assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
      } finally { await fixture.cleanup(); }
    });
  }
}

const optionalDistributions = [
  { label: "out-of-range", value: { low: -1, medium: 0, high: 2 } },
  { label: "wrong-shape", value: { low: "0.9", medium: 0.05, high: 0.05 } },
  { label: "rounded-sum", value: { low: 0.333, medium: 0.333, high: 0.333 } },
];

for (const { label, value } of optionalDistributions) {
  test(`${label} optional probabilities warn but cannot invalidate four valid core signals`, () => {
    const advisory = parseModelAdvisory(signals("low", value));
    assert.equal(advisory.status, "valid");
    assert.deepEqual(advisory.errors, []);
    assert.equal(advisory.risk.choice, "low");
    assert.equal(advisory.risk.probabilities, undefined, "invalid distribution must not influence severity");
    assert.equal(advisory.metadata.p_high, null);
    assert.equal(advisory.metadata.p_non_low, null);
    assert.ok(Array.isArray(advisory.metadata.warnings) && advisory.metadata.warnings.length > 0);
    assert.deepEqual(advisory.warnings, advisory.metadata.warnings);
    assert.equal(advisory.metadata.probabilityStatus, "invalid-distribution");
    assert.deepEqual(advisory.metadata.raw_class_probabilities, Object.fromEntries(Object.entries(value).map(([key, probability]) => [key, typeof probability === "number" && Number.isFinite(probability) ? probability : null])));
    assert.equal(severityOf(advisory), 0.1);
    assert.equal(decideModelAdvisory(advisory).kind, "delegate");
  });

  for (const toolName of ["edit", "mcp__fixture__query"]) {
    test(`manual never ${toolName} keeps allow with ${label} optional distribution`, async () => {
      const fixture = await denialFixture({ answers: signals("low", value) });
      try {
        const args = toolName === "edit" ? { file_path: "fixture.txt", old_string: "before", new_string: "after" } : { query: "fixture" };
        const { decision } = await fixture.run(toolName, args);
        assert.equal(decision.kind, "allow");
        if (toolName === "edit") {
          // safe 写不再问模型（审计 11-16 P1-2），所以可选的畸形分布根本
          // 走不到 advisory 解析；这条分支只钉「模型失败不能拒绝 safe 写」。
          assert.equal(fixture.primaryCalls, 0);
          assert.equal(fixture.details[0].scores.reasonCode, "safe-local-operation-host-sandbox");
          assert.equal(fixture.details[0].scores.decisionSource, "local_policy");
        } else {
          assert.equal(fixture.primaryCalls, 1);
          assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "completed");
        }
        assert.equal(fixture.fallbackCalls, 0);
        assert.equal(fixture.details[0].degraded, false);
        assert.equal(fixture.executions, 1);
      } finally { await fixture.cleanup(); }
    });
  }
}

for (const choice of ["low", "medium"]) {
  for (const optionalRisk of [
    { confidenceKind: "unrecognized-fixture-kind" },
    { confidenceKind: "normalized", confidence: 2 },
    { confidence: "not-a-number" },
    { probabilities: { low: Number.NaN, medium: 0.1, high: Number.POSITIVE_INFINITY } },
  ]) {
    test(`${choice} optional metadata ${JSON.stringify(optionalRisk)} is warning-only, never a core protocol failure`, async () => {
      const answers = signals(choice);
      Object.assign(answers.risk, optionalRisk);
      const advisory = parseModelAdvisory(answers);
      assert.equal(advisory.status, "valid");
      assert.deepEqual(advisory.errors, []);
      assert.equal(advisory.risk.choice, choice);
      assert.equal(advisory.risk.probabilities, undefined);
      assert.ok(advisory.metadata.warnings.length > 0);
      assert.deepEqual(advisory.warnings, advisory.metadata.warnings);
      assert.equal(severityOf(advisory), choice === "low" ? 0.1 : 0.5);
      const fixture = await denialFixture({ answers });
      try {
        const { decision } = await fixture.run("mcp__fixture__query", { query: "fixture" });
        assert.equal(decision.kind, "allow");
        assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "completed");
        assert.equal(fixture.details[0].degraded, false);
      } finally { await fixture.cleanup(); }
    });
  }
}

test("valid optional distribution remains available for severity and probability metadata", () => {
  const probabilities = { low: 0.9, medium: 0.05, high: 0.05 };
  const advisory = parseModelAdvisory(signals("low", probabilities));
  assert.equal(advisory.status, "valid");
  assert.deepEqual(advisory.risk.probabilities, probabilities);
  assert.equal(advisory.metadata.p_high, 0.05);
  assert.equal(advisory.metadata.p_non_low, 0.1);
});

for (const danger of ["high-risk", "injection"]) {
  test(`${danger} with malformed optional probabilities goes to fallback instead of silently passing`, async () => {
    const answers = signals(danger === "high-risk" ? "high" : "low", { low: -1, medium: 0, high: 2 });
    if (danger === "injection") answers.injection_suspect.noul = 0.99;
    const advisory = parseModelAdvisory(answers);
    assert.equal(advisory.status, "valid");
    assert.equal(decideModelAdvisory(advisory).kind, "ask");
    // 审计 P0-1：never 下非 safe 的 ask 交给回退审查者，由它做最终裁决。
    // 这里让回退明确拒绝，验证链路确实经过第二模型且保持 fail-closed。
    const fixture = await denialFixture({ answers, reviewAction: "deny" });
    try {
      const { decision } = await fixture.run("mcp__fixture__query", { query: "fixture" });
      assert.equal(decision.kind, "deny");
      assert.equal(fixture.executions, 0);
      assert.equal(fixture.fallbackCalls, 1, "应经过回退审查者，而不是模型一票即拒");
      assert.equal(fixture.primaryCalls, 1);
    } finally { await fixture.cleanup(); }
  });
}

for (const field of ["risk", "irreversible", "matches_task", "injection_suspect"]) {
  test(`missing required ${field} still fails closed rather than becoming an optional warning`, async () => {
    const answers = signals();
    delete answers[field];
    assert.equal(parseModelAdvisory(answers).status, "unknown");
    const fixture = await denialFixture({ answers });
    try {
      const { decision } = await fixture.run("mcp__fixture__query", { query: "fixture" });
      assert.equal(decision.kind, "deny");
      assert.equal(fixture.executions, 0);
      assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "failed");
    } finally { await fixture.cleanup(); }
  });
}

const constraints = [
  { name: "pwsh", args: { command: "fixture-only", sandbox_permissions: "danger-full-access" } },
  { name: "mcp__fixture__query", args: { query: "fixture" }, options: { hostDenied: true } },
  { name: "edit", args: { file_path: "fixture.txt", old_string: "before", new_string: "after" }, options: { sandbox: "read-only" } },
  { name: "edit", args: (root) => ({ file_path: join(root, "..", "outside-fixture.txt"), old_string: "before", new_string: "after" }) },
  { name: "pwsh", args: { command: "Remove-Item fixture-only.txt" } },
];
for (const fallback of ["allow", "deny", "session", "model"]) {
  for (const constraint of constraints) {
    test(`manual never hard ${constraint.name}/${constraints.indexOf(constraint)} survives ${fallback} fallback and low model`, async () => {
      const fixture = await denialFixture({ ...constraint.options, fallback });
      try {
        const args = typeof constraint.args === "function" ? constraint.args(fixture.root) : constraint.args;
        const { decision, downstream } = await fixture.run(constraint.name, args);
        assert.equal(decision.kind, "deny");
        assert.equal(fixture.primaryCalls, 0);
        assert.equal(fixture.fallbackCalls, 0);
        assert.equal(fixture.executions, 0);
        assert.ok(downstream());
      } finally { await fixture.cleanup(); }
    });
  }
}
