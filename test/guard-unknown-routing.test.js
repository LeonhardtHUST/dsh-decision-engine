import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mountGuard } from "../lib/guard/listener.js";
import { effectivePointModes } from "../lib/index.js";
import { TOLERANCE_LEVELS, ToleranceCalibrator } from "../lib/tolerance.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const userListing = "Get-ChildItem -Recurse -File lib | Select-Object -First 80 FullName | ForEach-Object { $_.FullName.Replace('D:\\Projects\\GitHub\\dsh-decision-engine\\','') }";
const opaqueCalls = [
  ["pwsh", { command: userListing }],
  ["unrecognized_fixture_tool", { query: "fixture" }],
  ["mcp__fixture__read", { query: "fixture" }],
  ["web_fetch", { url: "https://example.invalid/fixture" }],
];

async function createReviewFixture(options = {}) {
  const fixture = await createGuardFixture(options);
  const records = [];
  const details = [];
  const classified = [];
  const reviews = [];
  const facts = [];
  let sideEffects = 0;
  const session = {
    id: fixture.root, header: { cwd: fixture.root },
    requestHeader: () => ({ config: { provider: "fallback-fixture", model: "review-model", reasoningEffort: "medium" } }),
    snapshotEvents: () => [{ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Review and list fixture source files only." }] } }],
  };
  fixture.services.llm = { async *stream(request) {
    reviews.push(request);
    if (options.throwFallback) throw new Error("fixture-review-failed");
    yield { type: "text-delta", text: options.fallbackText ?? JSON.stringify({ action: options.reviewAction ?? "allow" }) };
    yield { type: "finish", reason: { kind: "stop" } };
  } };
  if (options.hostDenied) fixture.services.tools.executable = () => undefined;
  const hooks = new Map();
  mountGuard({ get: (name) => fixture.services[name], on: (name, callback) => hooks.set(name, callback), logger: { warn() {} } }, {
    getConfig: () => fixture.config, reloadOwnConfig: async () => {}, effectivePointModes,
    client: {
      recordDecision: (entry) => facts.push(entry),
      async classify(request) {
        classified.push(request);
        if (options.throwPrimary) throw new Error("fixture-primary-failed");
        if (options.degraded) return { degraded: "fixture-timeout", provider: "primary-fixture", model: "decision-model" };
        return { provider: "primary-fixture", model: "decision-model", answers: {
          risk: { type: "choice", choice: options.choice ?? "low", confidence: 0.9 },
          irreversible: { type: "noul", noul: 0.05 },
          matches_task: { type: "noul", noul: 0.99 },
          injection_suspect: { type: "noul", noul: 0.01 },
        } };
      },
    },
    toleranceCalibrator: new ToleranceCalibrator(), digestRecent: () => "fixture context, not authorization",
    previewArguments: (args) => JSON.stringify(args), logDecision: async (entry) => records.push(entry),
    recordGuardDetail: (entry) => details.push(entry),
  });
  return {
    ...fixture, records, details, classified, reviews, facts,
    get sideEffects() { return sideEffects; },
    async run(name, args) {
      const exec = { name, arguments: args, callId: `review-${records.length}`, token: Symbol("review"), agent: { id: session.id, session }, signal: new AbortController().signal };
      const decision = await hooks.get("tools/pre-execute")(exec, async () => { sideEffects += 1; return { kind: "allow" }; });
      return { decision, exec };
    },
  };
}

for (const [toolName, args] of opaqueCalls) {
  test(`Auto reviews opaque ${toolName} twice even when primary says low`, async () => {
    const fixture = await createReviewFixture();
    try {
      const { decision } = await fixture.run(toolName, args);
      assert.equal(fixture.classified.length, 1, "uncertainty must reach primary classification");
      assert.equal(fixture.reviews.length, 1, "opaque low is not a direct allow");
      assert.equal(fixture.records[0].audit.mandatory.status, "unknown");
      assert.equal(decision.kind, "allow");
      assert.equal(fixture.sideEffects, 1);
      assert.deepEqual(fixture.reviews[0].tools, []);
      assert.equal(fixture.reviews[0].provider, "fallback-fixture");
      assert.equal(fixture.reviews[0].model, "review-model");
      assert.equal(fixture.classified[0].state.permissionContext.mandatory, "unknown");
      assert.equal(fixture.details[0].scores.risk_p, 0.9);
      assert.equal(fixture.details[0].scores.decisionSource, "fallback_model");
      assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "completed");
      assert.equal(fixture.details[0].scores.modelEvaluation.primary.provider, "primary-fixture");
      assert.equal(fixture.details[0].scores.modelEvaluation.fallback.provider, "fallback-fixture");
      assert.equal(fixture.details[0].result.provider, "fallback-fixture");
      assert.equal(fixture.details[0].result.model, "review-model");
      assert.match(fixture.details[0].state.summary.sha256, /^[a-f0-9]{64}$/);
    } finally { await fixture.cleanup(); }
  });
}

for (const choice of ["medium", "high"]) {
  for (const reviewAction of ["allow", "deny"]) {
    for (const tolerance of TOLERANCE_LEVELS) {
      test(`Auto ${choice}/${tolerance} routes to independent LLM ${reviewAction}, not human ask`, async () => {
        const fixture = await createReviewFixture({ choice, reviewAction, config: { tolerance } });
        try {
          const { decision } = await fixture.run("pwsh", { command: userListing });
          assert.equal(fixture.classified.length, 1);
          assert.equal(fixture.reviews.length, 1);
          assert.equal(decision.kind, reviewAction);
          assert.equal(fixture.sideEffects, reviewAction === "allow" ? 1 : 0);
          assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown", "LLM allow is not user approval");
        } finally { await fixture.cleanup(); }
      });
    }
  }
}

for (const failure of [{ degraded: true }, { throwPrimary: true }]) {
  test(`Auto primary ${failure.throwPrimary ? "exception" : "degradation"} still uses independent review`, async () => {
    const fixture = await createReviewFixture(failure);
    try {
      const { decision } = await fixture.run("unrecognized_fixture_tool", {});
      assert.equal(fixture.classified.length, 1);
      assert.equal(fixture.reviews.length, 1);
      assert.equal(decision.kind, "allow");
      assert.match(fixture.details[0].state.summary.sha256, /^[a-f0-9]{64}$/);
      assert.match(fixture.details[0].detail, /[\u4e00-\u9fff]/u);
      assert.equal(fixture.details[0].degraded, true);
      assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "failed");
      assert.equal(fixture.details[0].scores.modelEvaluation.fallback.status, "completed");
      assert.equal(fixture.details[0].scores.decisionSource, "fallback_model");
      assert.equal(fixture.details[0].result.provider, "fallback-fixture");
      assert.equal(fixture.details[0].result.model, "review-model");
    } finally { await fixture.cleanup(); }
  });
}

for (const failure of [{ throwFallback: true }, { fallbackText: "not a decision" }]) {
  test(`Auto opaque low fails closed on ${failure.throwFallback ? "LLM failure" : "invalid review"}`, async () => {
    const fixture = await createReviewFixture(failure);
    try {
      const { decision } = await fixture.run("unrecognized_fixture_tool", {});
      assert.equal(fixture.classified.length, 1);
      assert.equal(fixture.reviews.length, 1);
      assert.equal(decision.kind, "deny");
      assert.equal(fixture.sideEffects, 0);
      assert.match(decision.reason, /[\u4e00-\u9fff]/u);
      assert.equal(fixture.details[0].scores.modelEvaluation.fallback.status, "failed");
    } finally { await fixture.cleanup(); }
  });
}

for (const reviewAction of ["allow", "deny"]) {
  test(`Auto unknown with approval never uses LLM ${reviewAction} without user approval`, async () => {
    const fixture = await createReviewFixture({ approval: "never", choice: "medium", reviewAction });
    try {
      const { decision } = await fixture.run("pwsh", { command: userListing });
      assert.equal(fixture.classified.length, 1);
      assert.equal(fixture.reviews.length, 1);
      assert.equal(decision.kind, reviewAction);
      assert.equal(fixture.sideEffects, reviewAction === "allow" ? 1 : 0);
      assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
    } finally { await fixture.cleanup(); }
  });
}

test("custom fallback model is the actual final judge without losing primary provenance", async () => {
  const fixture = await createReviewFixture({ config: { guardFallback: "model", guardFallbackProvider: "custom-reviewer", guardFallbackModel: "custom-model", guardFallbackReasoningEffort: "low" } });
  try {
    const { decision } = await fixture.run("unrecognized_fixture_tool", {});
    assert.equal(decision.kind, "allow");
    assert.equal(fixture.reviews.length, 1);
    assert.equal(fixture.reviews[0].provider, "custom-reviewer");
    assert.equal(fixture.reviews[0].model, "custom-model");
    assert.equal(fixture.reviews[0].reasoningEffort, "low");
    assert.equal(fixture.details[0].result.provider, "custom-reviewer");
    assert.equal(fixture.details[0].result.model, "custom-model");
    assert.equal(fixture.details[0].scores.modelEvaluation.primary.provider, "primary-fixture");
    assert.equal(fixture.details[0].scores.modelEvaluation.fallback.provider, "custom-reviewer");
  } finally { await fixture.cleanup(); }
});

for (const approval of ["ask", "never"]) {
  test(`manual unknown with approval ${approval} never fabricates approval`, async () => {
    const fixture = await createReviewFixture({ preset: "manual", approval, choice: "medium" });
    try {
      const { decision } = await fixture.run("unrecognized_fixture_tool", {});
      assert.equal(fixture.classified.length, 1);
      assert.equal(fixture.reviews.length, 0);
      assert.equal(decision.kind, approval === "ask" ? "ask" : "deny");
      assert.equal(fixture.sideEffects, 0);
      assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
    } finally { await fixture.cleanup(); }
  });
}

for (const fallback of ["allow", "deny"]) {
  test(`explicit ${fallback} fallback only chooses the soft uncertainty outcome`, async () => {
    const fixture = await createReviewFixture({ config: { guardFallback: fallback } });
    try {
      const { decision } = await fixture.run("unrecognized_fixture_tool", {});
      assert.equal(fixture.classified.length, 1);
      assert.equal(fixture.reviews.length, 0);
      assert.equal(fixture.records[0].audit.mandatory.status, "unknown");
      assert.equal(decision.kind, fallback);
      assert.equal(fixture.details[0].scores.decisionSource, "fallback_policy");
      assert.equal(fixture.sideEffects, fallback === "allow" ? 1 : 0);
      assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
    } finally { await fixture.cleanup(); }
  });
}

const hardCases = [
  { label: "explicit sandbox escalation", name: "pwsh", args: { command: userListing, sandbox_permissions: "danger-full-access" } },
  { label: "host tool denied", name: "list_agents", args: {}, options: { hostDenied: true } },
  { label: "read-only write", name: "write", args: { file_path: "fixture.txt", content: "fixture" }, options: { sandbox: "read-only" } },
  { label: "known outside workspace", name: "write", args: (root) => ({ file_path: join(root, "..", "outside-fixture.txt"), content: "fixture" }) },
  { label: "multi-target patch outside workspace", name: "apply_patch", args: (root) => ({ input: `*** Begin Patch\n*** Update File: ${join(root, "allowed.txt")}\n@@\n-fixture\n+patched\n*** Update File: ${join(root, "..", "outside-fixture.txt")}\n@@\n-fixture\n+escape\n*** End Patch` }) },
  { label: "known outside patch plus unresolved target", name: "apply_patch", args: (root) => ({ patch: `*** Begin Patch\n*** Update File: ${join(root, "..", "outside-fixture.txt")}\n@@\n-fixture\n+escape\n*** Update File: unresolved$target.txt\n@@\n-fixture\n+patched\n*** End Patch` }) },
  { label: "privileged shell", name: "pwsh", args: { command: "sudo fixture-only-command" } },
  { label: "destructive shell", name: "pwsh", args: { command: "Remove-Item fixture-only.txt" } },
];

for (const fallback of ["session", "model", "allow", "deny"]) {
  for (const hardCase of hardCases) {
    for (const approval of ["ask", "never"]) {
      test(`${fallback}/${approval}: ${hardCase.label} cannot be softened by LLM or allow fallback`, async () => {
        const fixture = await createReviewFixture({ ...hardCase.options, approval, config: { guardFallback: fallback, guardFallbackProvider: "fallback-fixture", guardFallbackModel: "review-model" } });
        try {
          const args = typeof hardCase.args === "function" ? hardCase.args(fixture.root) : hardCase.args;
          const { decision, exec } = await fixture.run(hardCase.name, args);
          assert.equal(decision.kind, hardCase.options?.hostDenied || approval === "never" ? "deny" : "ask");
          assert.equal(fixture.classified.length, 0);
          assert.equal(fixture.reviews.length, 0);
          assert.equal(fixture.sideEffects, 0);
          assert.ok(fixture.guard(exec), "downstream guard must still reject missing real host approval");
          assert.match(fixture.details[0].state.summary.sha256, /^[a-f0-9]{64}$/);
          assert.equal(fixture.details[0].questions.status, "not_requested");
          assert.equal(fixture.details[0].scores.modelEvaluation.status, "not_requested");
          assert.equal(fixture.details[0].scores.decisionSource, "local_policy");
          assert.equal(fixture.details[0].result, undefined);
          assert.ok(fixture.facts.every((entry) => entry.facts === undefined), "early rules cannot invent model facts");
        } finally { await fixture.cleanup(); }
      });
    }
  }
}

for (const [toolName, args] of [
  ["list_agents", {}],
  ["skill", { name: "dsh-doc" }],
  ["cordis_inspect_list", {}],
  ["cordis_inspect_query", { platform: "host", provider: "fixture", method: "schema", input: {} }],
  ["list_subagent_models", { provider: "fixture", model: "review-model" }],
]) {
  test(`known safe ${toolName} skips both models without inventing facts or questions`, async () => {
    const fixture = await createReviewFixture({ approval: "never", choice: "high" });
    try {
      const { decision } = await fixture.run(toolName, args);
      assert.equal(decision.kind, "allow");
      assert.equal(fixture.classified.length, 0);
      assert.equal(fixture.reviews.length, 0);
      assert.equal(fixture.details[0].result, undefined);
      assert.equal(fixture.details[0].questions.status, "not_requested");
      assert.match(fixture.details[0].state.summary.sha256, /^[a-f0-9]{64}$/);
      assert.ok(fixture.facts.every((entry) => entry.facts === undefined));
      assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
    } finally { await fixture.cleanup(); }
  });
}
