import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mountGuard } from "../lib/guard/listener.js";
import { effectivePointModes } from "../lib/index.js";
import { TOLERANCE_LEVELS, ToleranceCalibrator } from "../lib/tolerance.js";
import { createGuardFixture } from "./helpers/guard-fixture.js";

const userListing = "Get-ChildItem -Recurse -File lib | Select-Object -First 80 FullName | ForEach-Object { $_.FullName.Replace('D:\\Projects\\GitHub\\dsh-decision-engine\\','') }";
// 本地未知副作用：`pwsh` 的命令内容与未注册工具都无法静态判定，但它们的作用域
// 仍在本机。主模型给出有效的低风险意见后，不再为 `mandatory=unknown` 二次复核。
const localUnknownCalls = [
  ["pwsh", { command: userListing }],
  ["unrecognized_fixture_tool", { query: "fixture" }],
];
// 外网 / MCP 的副作用边界在宿主之外：第二次独立复核是刻意保留的安全余量，
// 不能被上面那条豁免覆盖（effect.kind 是 external_network 而不是 unknown）。
const externalCalls = [
  ["mcp__fixture__read", { query: "fixture" }],
  ["web_fetch", { url: "https://example.invalid/fixture" }],
];

async function createReviewFixture(options = {}) {
  const fixture = await createGuardFixture({ ...options, config: { guardDeferOutsideWorkspace: false, ...options.config } });
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
          risk: { type: "choice", choice: options.choice ?? "low", confidence: 0.9, ...(options.probabilities === undefined ? {} : { probabilities: options.probabilities }) },
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

for (const [toolName, args] of localUnknownCalls) {
  test(`Auto keeps local unknown ${toolName} on the primary decision without a second review`, async () => {
    const fixture = await createReviewFixture();
    try {
      const { decision } = await fixture.run(toolName, args);
      assert.equal(fixture.classified.length, 1, "uncertainty must reach primary classification");
      assert.equal(fixture.reviews.length, 0, "本地未知副作用不再为 mandatory=unknown 二次复核");
      assert.equal(fixture.records[0].audit.mandatory.status, "unknown", "mandatory 仍是 unknown：不确定性照旧记录，只是不单独升级");
      assert.equal(decision.kind, "allow");
      assert.equal(fixture.sideEffects, 1);
      assert.equal(fixture.details[0].scores.decisionSource, "primary_model");
      assert.equal(fixture.details[0].scores.modelEvaluation.primary.status, "completed");
      assert.equal(fixture.details[0].scores.modelEvaluation.primary.provider, "primary-fixture");
      assert.equal(fixture.details[0].scores.modelEvaluation.fallback.status, "not_requested");
      assert.equal(fixture.details[0].result.provider, "primary-fixture");
      assert.equal(fixture.details[0].result.model, "decision-model");
      assert.match(fixture.details[0].state.summary.sha256, /^[a-f0-9]{64}$/);
    } finally { await fixture.cleanup(); }
  });
}

for (const [toolName, args] of externalCalls) {
  test(`Auto reviews external ${toolName} twice even when primary says low`, async () => {
    const fixture = await createReviewFixture();
    try {
      const { decision } = await fixture.run(toolName, args);
      assert.equal(fixture.classified.length, 1, "uncertainty must reach primary classification");
      assert.equal(fixture.reviews.length, 1, "外部边界仍保留第二次独立复核");
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
  // 用 external_network 的 MCP 工具：它会走到第二次独立复核，失败时仍然闭锁。
  // 本地未知副作用在没有强制约束时不再二次复核，因此不能再拿它验证「回退失败闭锁」。
  test(`Auto external ${failure.throwFallback ? "LLM failure" : "invalid review"} still fails closed`, async () => {
    const fixture = await createReviewFixture(failure);
    try {
      const { decision } = await fixture.run("mcp__fixture__read", { query: "fixture" });
      assert.equal(fixture.classified.length, 1);
      assert.equal(fixture.reviews.length, 1);
      assert.equal(decision.kind, "deny");
      assert.equal(fixture.sideEffects, 0);
      assert.match(decision.reason, /[\u4e00-\u9fff]/u);
      assert.equal(fixture.details[0].scores.modelEvaluation.fallback.status, "failed");
      assert.equal(fixture.details[0].scores.decisionSource, "fallback_model");
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

test("safe 写 + 可用审批通道：回退模型的软拒绝转成宿主原生询问", async () => {
  // 凌晨日志现场：mandatory=safe 的工作区内 edit 在 approvalPolicy=ask 下被
  // fallback-model-deny 直接拒绝——可宿主明明有原生审批卡可用。`safe` 只说明
  // 本地静态规则已确认工作区内可逆操作，模型/回退的结论是软审查摩擦，正确
  // 收尾是交回宿主原生审批，而不是让插件的第二个模型替用户说不。
  const fixture = await createReviewFixture({ approval: "ask", choice: "medium", reviewAction: "deny" });
  try {
    const { decision } = await fixture.run("write", { file_path: "allowed.txt", content: "fixture" });
    assert.equal(fixture.classified.length, 1);
    assert.equal(fixture.reviews.length, 1);
    const audit = fixture.records[0].audit;
    assert.equal(audit.mandatory.status, "safe", "本地规则已判定工作区内安全");
    assert.equal(audit.baseAction, "ask");
    assert.equal(audit.decisionSource, "fallback_model");
    assert.equal(audit.fallback.fallback, "session");
    assert.equal(audit.fallback.reason, "fallback-model-deny");
    assert.equal(decision.kind, "ask", "回退软拒绝不能替用户拒绝，应转成宿主审批");
    assert.equal(audit.reasonCode, "safe-soft-review-ask");
    assert.match(audit.humanReason, /fallback-model-deny/, "回退原因必须保留到审计");
    assert.match(audit.humanReason, /model-material-risk/, "主模型的疑问原因也必须保留到审计");
    assert.equal(audit.pluginReturnedAction, "ask");
    assert.equal(decision.displayReason.zh, "回退模型建议拒绝此次安全操作，交宿主原生审批决定");
    assert.equal(decision.displayReason.en, "The fallback review suggested denying this safe operation; the host native approval decides");
    assert.equal(fixture.sideEffects, 0, "没有真实宿主批准就不能执行");
    assert.equal(audit.hostApprovalStatus, "unknown", "插件询问不等于用户批准");
  } finally { await fixture.cleanup(); }
});

test("safe 写 + 可用审批通道：回退复核失败/无效仍是 deny（有审批通道不等于放行）", async () => {
  // 只有回退模型的**明确裁决**（fallback-model-deny）才是软审查摩擦；回退
  // 失败、超时、路线缺失必须继续 fail-closed，不能因为「有审批通道」被洗成
  // 一次询问。
  for (const failure of [{ throwFallback: true }, { fallbackText: "not a decision" }]) {
    const fixture = await createReviewFixture({ approval: "ask", choice: "medium", ...failure });
    try {
      const { decision } = await fixture.run("write", { file_path: "allowed.txt", content: "fixture" });
      assert.equal(fixture.reviews.length, 1);
      assert.equal(decision.kind, "deny", JSON.stringify(failure));
      assert.equal(fixture.sideEffects, 0);
      assert.equal(fixture.records[0].audit.mandatory.status, "safe");
      assert.equal(fixture.records[0].audit.reasonCode, "fallback-review-failed");
      assert.notEqual(fixture.details[0]?.scores?.reasonCode, "safe-soft-review-ask", "失败不能被记成一次询问");
    } finally { await fixture.cleanup(); }
  }
});

test("custom fallback model is the actual final judge without losing primary provenance", async () => {
  // external_network：仍会二次复核，因此能用它验证自定义回退路由真的被用上。
  const fixture = await createReviewFixture({ config: { guardFallback: "model", guardFallbackProvider: "custom-reviewer", guardFallbackModel: "custom-model", guardFallbackReasoningEffort: "low" } });
  try {
    const { decision } = await fixture.run("mcp__fixture__read", { query: "fixture" });
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
  test(`manual unknown with approval ${approval} 遵守审批通道（never 交回退，ask 真问）`, async () => {
    const fixture = await createReviewFixture({ preset: "manual", approval, choice: "medium" });
    try {
      const { decision } = await fixture.run("unrecognized_fixture_tool", {});
      assert.equal(fixture.classified.length, 1);
      // never：本地未知副作用不能靠模型一票通过，交给配置的回退审查者；
      // ask：审批通道存在，直接问人（不额外叫回退模型）。
      assert.equal(fixture.reviews.length, approval === "never" ? 1 : 0);
      assert.equal(decision.kind, approval === "ask" ? "ask" : "allow");
      assert.equal(fixture.sideEffects, approval === "ask" ? 0 : 1);
      assert.equal(fixture.records[0].audit.hostApprovalStatus, "unknown");
    } finally { await fixture.cleanup(); }
  });
}

for (const fallback of ["allow", "deny"]) {
  test(`explicit ${fallback} fallback only chooses the soft uncertainty outcome`, async () => {
    // 显式 allow / deny 是用户写下的政策裁决，不属于「本地未知副作用」豁免范围：
    // 这两种策略都不需要多叫一次模型，但它们的结论必须照旧生效。
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

test("tolerance 触发的 ask 带双语审批卡标题，档位原文只留在审计", async () => {
  // 构造「relaxed 档按严重度尾部提问、而模型本身判低风险」的情形：
  // choice=low 让 baseAction=delegate，probabilities 让 severity 达线（0.8 ≥ 0.6），
  // 于是这次询问是**档位**要求的，不是模型要求的。
  const fixture = await createReviewFixture({ preset: "manual", approval: "ask", config: { tolerance: "relaxed" }, probabilities: { low: 0.05, medium: 0.3, high: 0.65 } });
  try {
    const { decision } = await fixture.run("mcp__fixture__read", { query: "fixture" });
    assert.equal(decision.kind, "ask");
    assert.equal(fixture.records[0].audit.baseAction, "delegate", "模型本身判定可放行（delegate），询问来自档位");
    assert.equal(fixture.records[0].audit.tolerance.changed, true);
    // 审批卡标题：固定双语文案，不含档位 note 里的字段名与裸小数。
    assert.equal(decision.displayReason.zh, "安全档位要求确认此次调用");
    assert.equal(decision.displayReason.en, "The safety level asks for confirmation");
    for (const text of [decision.displayReason.zh, decision.displayReason.en]) {
      assert.doesNotMatch(text, /severity=|tolerance=|cutoff=|\d\.\d/);
    }
    // 审计/遥测口径不变：reasonCode 指认来源，note 逐字保留在 humanReason。
    assert.equal(fixture.records[0].audit.reasonCode, "tolerance-ask");
    assert.match(fixture.records[0].audit.humanReason, /tolerance=relaxed/);
    assert.equal(fixture.details[0].scores.reasonCode, "tolerance-ask");
    assert.match(fixture.details[0].detail, /tolerance=relaxed/);
  } finally { await fixture.cleanup(); }
});

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
  // job_output 是严格的只读查询：一条「读一下后台任务输出」不该先花一次模型调用。
  ["job_output", { job_id: "fixture-job", wait: true, timeout_ms: 5000 }],
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
