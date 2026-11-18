import test from "node:test";
import assert from "node:assert/strict";
import { fallbackSelection, guardModelCatalog, redactGuardData, reviewWithFallback } from "../lib/guard/fallback.js";

const session = { id: "fixture", requestHeader: () => ({ config: { provider: "host", model: "session", reasoningEffort: "medium" } }) };
const base = { config: { guardFallback: "session", timeoutMs: 30 }, mandatory: { status: "unknown" }, state: { tool: "pwsh" }, session };
const model = (text, finish = "stop") => ({ async *stream() { yield { type: "text-delta", text }; yield { type: "finish", reason: { kind: finish } }; } });

test("fallback 四策略只处理软审核，mandatory在全部允许下仍拒绝", async () => {
  for (const policy of ["allow", "deny", "session", "model"]) {
    for (const status of ["deny", "requires_approval"]) {
      const result = await reviewWithFallback({ ...base, config: { guardFallback: policy }, mandatory: { status }, llm: model('{"action":"allow"}') });
      assert.equal(result.kind, "deny");
    }
  }
  assert.equal((await reviewWithFallback({ ...base, config: { guardFallback: "allow" } })).kind, "delegate");
  assert.equal((await reviewWithFallback({ ...base, config: { guardFallback: "deny" } })).kind, "deny");
});

test("fallback沿用会话模型和reasoning effort，自定义路由支持单独effort", () => {
  assert.deepEqual(fallbackSelection(base.config, session), { provider: "host", model: "session", reasoningEffort: "medium" });
  assert.deepEqual(fallbackSelection({ guardFallback: "model", guardFallbackProvider: "other", guardFallbackModel: "review", guardFallbackReasoningEffort: "high" }, session), { provider: "other", model: "review", reasoningEffort: "high" });
  assert.equal(fallbackSelection({ guardFallback: "model" }, session), undefined);
});

test("fallback无工具调用权限，严格完整JSON才能放行", async () => {
  let request;
  const llm = { async *stream(options) { request = options; yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; } };
  assert.equal((await reviewWithFallback({ ...base, llm })).kind, "delegate");
  assert.deepEqual(request.tools, []);
  assert.equal(request.reasoningEffort, "medium");
  for (const text of ['allow', '{"action":"ask"}', '{"action":"allow","extra":true}', '```json\n{"action":"allow"}\n```']) {
    assert.equal((await reviewWithFallback({ ...base, llm: model(text) })).kind, "deny");
  }
  assert.equal((await reviewWithFallback({ ...base, llm: model('{"action":"allow"}', "max-tokens") })).kind, "deny");
});

test("fallback缺模型、异常与不遵守signal的超时都失败关闭", async () => {
  assert.equal((await reviewWithFallback(base)).kind, "deny");
  assert.equal((await reviewWithFallback({ ...base, llm: { async *stream() { throw new Error("fixture"); } } })).kind, "deny");
  const result = await reviewWithFallback({ ...base, llm: { async *stream() { await new Promise(() => {}); } } });
  assert.equal(result.kind, "deny");
});

test("取消不转换为放行", async () => {
  const controller = new AbortController(); controller.abort();
  assert.equal((await reviewWithFallback({ ...base, signal: controller.signal })).kind, "cancel");
});

test("模型目录只返回显示元数据并按需发现reasoning effort", async () => {
  const llm = { listProviders: () => [{ id: "host", name: "Host", apiKey: "not-visible" }], listModels: async () => [{ id: "review", name: "Review", password: "secret" }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "low", name: "Low" }] } }) };
  const catalog = await guardModelCatalog(llm, "host", "review");
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.providers[0].models[0].reasoningEfforts, [{ id: "low", name: "Low" }]);
  assert.doesNotMatch(JSON.stringify(catalog), /apiKey|password|secret|not-visible/);
  assert.equal((await guardModelCatalog(undefined)).available, false);
});

test("fallback保留终端error和aborted的白名单分类且不返回秘密", async () => {
  const canary = "private-canary-https://secret.invalid/?token=fixture";
  for (const kind of ["error", "aborted"]) {
    for (const code of ["QUOTA", "AUTH", "RATE_LIMIT", "UNKNOWN", canary]) {
      const llm = { async *stream() {
        yield { type: "text-delta", text: '{"action":"allow"}' };
        yield { type: "finish", reason: { kind, failure: { code, status: 429, message: canary, body: canary, rawHeaders: canary, url: canary } } };
      } };
      const result = await reviewWithFallback({ ...base, llm });
      assert.equal(result.kind, "deny");
      assert.equal(result.reason, "fallback-review-failed");
      assert.deepEqual(result.failure, { stage: "finish", code: code === canary ? "UNKNOWN" : code, httpStatus: 429, finishReason: kind });
      assert.ok(!JSON.stringify(result).includes(canary));
    }
  }
});

test("fallback SDK和迭代异常只保留固定分类及可信status", async () => {
  const canary = "private-sdk-canary";
  for (const stage of ["sdk", "stream"]) {
    for (const code of ["QUOTA", "AUTH", "RATE_LIMIT", canary]) {
      const error = Object.assign(new Error(canary), { code, failure: { code, status: 401, message: canary, headers: canary } });
      const llm = stage === "sdk" ? { stream() { throw error; } } : { async *stream() { throw error; } };
      const result = await reviewWithFallback({ ...base, llm });
      assert.equal(result.kind, "deny");
      assert.equal(result.reason, "fallback-review-failed");
      assert.deepEqual(result.failure, { stage, code: code === canary ? "UNKNOWN" : code, httpStatus: 401, finishReason: null });
      assert.ok(!JSON.stringify(result).includes(canary));
    }
  }
});

test("fallback输出上限缺finish非法JSON和schema及非stop有固定分类", async () => {
  const cases = [
    [model("x".repeat(4097)), "output", "OUTPUT_LIMIT", null],
    [{ async *stream() { yield { type: "text-delta", text: '{"action":"allow"}' }; } }, "finish", "MISSING_FINISH", null],
    [model("private-parse-canary"), "parse", "INVALID_JSON", null],
    [model(""), "parse", "INVALID_JSON", null],
    [model('{"action":"allow","secret":"private-schema-canary"}'), "schema", "INVALID_SCHEMA", null],
    [model('{"action":"allow"}', "max-tokens"), "finish", "NON_STOP_FINISH", "max-tokens"],
    [model('{"action":"allow"}', "private-finish-canary"), "finish", "NON_STOP_FINISH", null],
  ];
  for (const [llm, stage, code, finishReason] of cases) {
    const result = await reviewWithFallback({ ...base, llm });
    assert.equal(result.kind, "deny");
    assert.equal(result.reason, "fallback-review-failed");
    assert.deepEqual(result.failure, { stage, code, httpStatus: null, finishReason });
    assert.doesNotMatch(JSON.stringify(result), /private-.*-canary/);
  }
  for (const action of ["allow", "deny"]) {
    const result = await reviewWithFallback({ ...base, llm: model(JSON.stringify({ action })) });
    assert.equal(Object.hasOwn(result, "failure"), false);
  }
});

test("fallback超时与调用者取消有固定reason且绝不放行", async () => {
  const hanging = { async *stream() { await new Promise(() => {}); } };
  const timeout = await reviewWithFallback({ ...base, llm: hanging });
  assert.equal(timeout.kind, "deny");
  assert.equal(timeout.reason, "review-timeout");
  assert.deepEqual(timeout.failure, { stage: "deadline", code: "TIMEOUT", httpStatus: null, finishReason: null });
  const expired = await reviewWithFallback({ ...base, deadline: { timedOut: true }, llm: model('{"action":"allow"}') });
  assert.deepEqual(expired.failure, timeout.failure);
  for (const preAborted of [false, true]) {
    for (const throughDeadline of [false, true]) {
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("private-abort-canary"));
      if (preAborted) cancel();
      const llm = { async *stream() { cancel(); yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; } };
      const result = await reviewWithFallback({ ...base, llm, ...(throughDeadline ? { deadline: { signal: controller.signal, remainingMs: 100 } } : { signal: controller.signal }) });
      assert.equal(result.kind, "cancel");
      assert.equal(result.reason, "review-cancelled");
      assert.deepEqual(result.failure, { stage: "cancel", code: "ABORTED", httpStatus: null, finishReason: null });
      assert.doesNotMatch(JSON.stringify(result), /private-abort-canary/);
    }
  }
});

test("外部审查前遮盖常见密钥字段和bearer值", () => {
  assert.deepEqual(redactGuardData({ apiKey: "123", args: { token: "456" }, text: "Bearer abcdefghijklmnop" }), { apiKey: "[redacted]", args: { token: "[redacted]" }, text: "[redacted]" });
});

// ---- 回退模型思考档位能力预检（LOG-001）------------------------------------

const capabilities = (provider, model, efforts) => ({
  provider,
  id: model,
  name: "Fixture",
  reasoning: { efforts: efforts.map((id) => ({ id, name: id.toUpperCase() })) },
});
const unsupportedFailure = { stage: "selection", code: "UNSUPPORTED_REASONING_EFFORT", httpStatus: null, finishReason: null };

test("显式档位不被回退模型支持时，在stream前拒绝并保留原route和effort", async () => {
  for (const policy of ["session", "model"]) {
    for (const effort of ["off", "medium", "max"]) {
      let streams = 0;
      const info = policy === "session"
        ? capabilities("host", "session", ["low", "high"])
        : capabilities("other", "review", ["low", "high"]);
      const llm = {
        resolveModelInfo: async () => info,
        async *stream() { streams += 1; yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; },
      };
      const config = policy === "model"
        ? { guardFallback: "model", guardFallbackProvider: "other", guardFallbackModel: "review", guardFallbackReasoningEffort: effort, timeoutMs: 100 }
        : { guardFallback: "session", timeoutMs: 100 };
      const result = await reviewWithFallback({ ...base, config, llm });
      assert.equal(result.kind, "deny");
      assert.equal(result.reason, "fallback-model-incompatible");
      assert.deepEqual(result.failure, unsupportedFailure);
      assert.deepEqual(result.selection, policy === "model"
        ? { provider: "other", model: "review", reasoningEffort: effort }
        : { provider: "host", model: "session", reasoningEffort: "medium" });
      assert.equal(streams, 0, "不支持的档位绝不能发出模型请求");
      assert.ok(!JSON.stringify(result).includes(info.name), "不回显能力元数据");
    }
  }
});

test("显式档位受支持时原样stream，不换模型也不换档位", async () => {
  let request;
  const llm = {
    resolveModelInfo: async (provider, model) => capabilities(provider, model, ["off", "low", "medium", "high"]),
    async *stream(options) { request = options; yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; },
  };
  const result = await reviewWithFallback({ ...base, llm });
  assert.equal(result.kind, "delegate");
  assert.equal(result.reason, "fallback-model-allow");
  assert.deepEqual(result.selection, { provider: "host", model: "session", reasoningEffort: "medium" });
  assert.equal(request.provider, "host");
  assert.equal(request.model, "session");
  assert.equal(request.reasoningEffort, "medium");
});

test("没有显式effort时不查能力目录、不选最小档位，交宿主默认", async () => {
  let resolved = 0;
  let request;
  const llm = {
    resolveModelInfo: async () => { resolved += 1; return capabilities("other", "review", ["low"]); },
    async *stream(options) { request = options; yield { type: "text-delta", text: '{"action":"deny"}' }; yield { type: "finish", reason: { kind: "stop" } }; },
  };
  const result = await reviewWithFallback({ ...base, config: { guardFallback: "model", guardFallbackProvider: "other", guardFallbackModel: "review", timeoutMs: 100 }, llm });
  assert.equal(result.kind, "deny");
  assert.equal(resolved, 0, "无显式档位时不应为了挑默认值去查能力");
  assert.equal(Object.hasOwn(request, "reasoningEffort"), false, "不能替调用方补一个最小档位");
});

test("旧宿主没有resolveModelInfo时保留原SDK验证路径且不额外放行", async () => {
  let request;
  const llm = {
    async *stream(options) { request = options; yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; },
  };
  const result = await reviewWithFallback({ ...base, llm });
  assert.equal(result.kind, "delegate");
  assert.equal(result.reason, "fallback-model-allow");
  assert.equal(request.reasoningEffort, "medium");
});

test("能力元数据抛错或非法时保守失败，零stream且不回显异常原文", async () => {
  const canary = "private-capability-canary-https://secret.invalid/?token=fixture";
  const throwing = Object.assign(new Error(canary), { code: canary, failure: { code: canary, status: 401, message: canary, headers: canary } });
  const llm = {
    resolveModelInfo: async () => { throw throwing; },
    async *stream() { throw new Error("stream must not start"); },
  };
  const generic = await reviewWithFallback({ ...base, llm });
  assert.equal(generic.kind, "deny");
  assert.equal(generic.reason, "fallback-review-failed");
  assert.deepEqual(generic.failure, { stage: "selection", code: "UNKNOWN", httpStatus: null, finishReason: null });
  assert.deepEqual(generic.selection, { provider: "host", model: "session", reasoningEffort: "medium" });
  assert.ok(!JSON.stringify(generic).includes(canary));

  const invalid = await reviewWithFallback({
    ...base,
    llm: { resolveModelInfo: async () => ({ provider: "host", id: "session" }), stream() { throw new Error("stream must not start"); } },
  });
  assert.equal(invalid.kind, "deny");
  assert.equal(invalid.reason, "fallback-review-failed");
  assert.deepEqual(invalid.failure, { stage: "selection", code: "INVALID_MODEL_INFO", httpStatus: null, finishReason: null });
});

test("显式档位不支持时同样遵守mandatory优先级，不查能力也不stream", async () => {
  for (const policy of ["session", "model"]) {
    let resolved = 0;
    let streams = 0;
    const llm = {
      resolveModelInfo: async () => { resolved += 1; throw new Error("must not resolve"); },
      stream() { streams += 1; throw new Error("must not stream"); },
    };
    const config = policy === "model"
      ? { guardFallback: "model", guardFallbackProvider: "other", guardFallbackModel: "review", guardFallbackReasoningEffort: "max" }
      : { guardFallback: "session" };
    const result = await reviewWithFallback({ ...base, config, mandatory: { status: "requires_approval" }, llm });
    assert.equal(result.kind, "deny");
    assert.equal(result.reason, "mandatory-policy-protected");
    assert.equal(resolved, 0);
    assert.equal(streams, 0);
  }
});

test("能力查询永不返回时由共享deadline收口，迟到resolve也绝不启动stream", async () => {
  let release;
  let streams = 0;
  const llm = {
    resolveModelInfo: () => new Promise((resolve) => { release = resolve; }),
    async *stream() { streams += 1; yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; },
  };
  const result = await reviewWithFallback({ ...base, config: { guardFallback: "session", timeoutMs: 30 }, llm });
  assert.equal(result.kind, "deny");
  assert.equal(result.reason, "review-timeout");
  assert.deepEqual(result.failure, { stage: "deadline", code: "TIMEOUT", httpStatus: null, finishReason: null });
  assert.deepEqual(result.selection, { provider: "host", model: "session", reasoningEffort: "medium" });
  assert.equal(streams, 0);
  release(capabilities("host", "session", ["medium"]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(streams, 0, "timeout之后迟到的能力结果不能触发模型请求");
});

test("能力查询期间取消时保留cancel原因，且不启动stream", async () => {
  const controller = new AbortController();
  let streams = 0;
  const llm = {
    resolveModelInfo() {
      controller.abort(new Error("private-abort-canary"));
      return new Promise(() => {});
    },
    async *stream() { streams += 1; yield { type: "text-delta", text: '{"action":"allow"}' }; yield { type: "finish", reason: { kind: "stop" } }; },
  };
  const result = await reviewWithFallback({ ...base, llm, signal: controller.signal });
  assert.equal(result.kind, "cancel");
  assert.equal(result.reason, "review-cancelled");
  assert.deepEqual(result.failure, { stage: "cancel", code: "ABORTED", httpStatus: null, finishReason: null });
  assert.equal(streams, 0);
  assert.ok(!JSON.stringify(result).includes("private-abort-canary"));
});

// ---- Codex guardian 回答协议（exact model id codex-auto-review）------------

const codexRoute = (effort) => ({
  guardFallback: "model",
  guardFallbackProvider: "user-alias",
  guardFallbackModel: "codex-auto-review",
  ...(effort ? { guardFallbackReasoningEffort: effort } : {}),
  timeoutMs: 100,
});
const codexInfo = (provider = "user-alias", model = "codex-auto-review") => capabilities(provider, model, ["low", "medium", "high"]);
const guardianStream = (text, finish = "stop") => ({
  async *stream() {
    yield { type: "text-delta", text };
    yield { type: "finish", reason: { kind: finish } };
  },
});

test("Codex 回退的 off 档仍在 stream 前拒绝，零请求且不回显元数据", async () => {
  let streams = 0;
  const llm = {
    resolveModelInfo: async () => codexInfo(),
    async *stream() { streams += 1; throw new Error("must not stream"); },
  };
  const result = await reviewWithFallback({ ...base, config: codexRoute("off"), llm });
  assert.equal(result.kind, "deny");
  assert.equal(result.reason, "fallback-model-incompatible");
  assert.deepEqual(result.failure, unsupportedFailure);
  assert.deepEqual(result.selection, { provider: "user-alias", model: "codex-auto-review", reasoningEffort: "off" });
  assert.equal(streams, 0, "不支持的档位绝不能发出模型请求");
  assert.ok(!JSON.stringify(result).includes("Fixture"), "不回显能力元数据");
});

test("Codex 回退在 low 档原样请求，并用 guardian 协议解析 outcome", async () => {
  let request;
  const llm = {
    resolveModelInfo: async () => codexInfo(),
    async *stream(options) {
      request = options;
      yield { type: "text-delta", text: '{"outcome":"allow","risk_level":"low","rationale":"private-rationale-canary"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const result = await reviewWithFallback({ ...base, config: codexRoute("low"), llm });
  assert.equal(result.kind, "delegate");
  assert.equal(result.reason, "fallback-model-allow");
  assert.equal(request.provider, "user-alias");
  assert.equal(request.model, "codex-auto-review");
  assert.equal(request.reasoningEffort, "low", "档位必须原样透传，不自动改档");
  assert.deepEqual(request.tools, []);
  assert.match(request.system, /"outcome"/);
  assert.match(request.system, /"user_authorization"/);
  assert.doesNotMatch(request.system, /Return ONLY a JSON object \{"action":"allow"\}/);
  assert.doesNotMatch(JSON.stringify(result), /private-rationale-canary/, "模型 rationale 不进入裁决结果");
});

test("Codex 回退留空档位时不查能力、交宿主默认，仍用 guardian 协议", async () => {
  let resolved = 0;
  let request;
  const llm = {
    resolveModelInfo: async () => { resolved += 1; return codexInfo(); },
    async *stream(options) {
      request = options;
      yield { type: "text-delta", text: '{"outcome":"allow"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const result = await reviewWithFallback({ ...base, config: codexRoute(""), llm });
  assert.equal(result.kind, "delegate");
  assert.equal(resolved, 0, "无显式档位时不应为了挑默认值去查能力");
  assert.equal(Object.hasOwn(request, "reasoningEffort"), false);
  assert.match(request.system, /"outcome"/);
});

test("会话路由选中 Codex 模型时同样走 guardian，provider 别名无关", async () => {
  let request;
  const codexSession = {
    id: "fixture",
    requestHeader: () => ({ config: { provider: "renamed-route", model: "codex-auto-review", reasoningEffort: "medium" } }),
  };
  const llm = {
    resolveModelInfo: async () => codexInfo("renamed-route", "codex-auto-review"),
    async *stream(options) {
      request = options;
      yield { type: "text-delta", text: '{"outcome":"deny"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const result = await reviewWithFallback({ ...base, session: codexSession, llm });
  assert.equal(result.kind, "deny");
  assert.equal(result.reason, "fallback-model-deny");
  assert.equal(request.reasoningEffort, "medium");
  assert.match(request.system, /"user_authorization"/);
});

test("同名 provider 的普通模型仍用 action 协议，guardian 形状按 schema 拒绝", async () => {
  let request;
  const plainConfig = { ...codexRoute("low"), guardFallbackModel: "gpt-6-sol" };
  const llm = {
    resolveModelInfo: async () => capabilities("user-alias", "gpt-6-sol", ["low"]),
    async *stream(options) {
      request = options;
      yield { type: "text-delta", text: '{"action":"allow"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const ok = await reviewWithFallback({ ...base, config: plainConfig, llm });
  assert.equal(ok.kind, "delegate");
  assert.match(request.system, /Return ONLY a JSON object \{"action":"allow"\}/);
  assert.doesNotMatch(request.system, /risk_level|outcome/);

  const rejected = await reviewWithFallback({
    ...base,
    config: plainConfig,
    llm: { resolveModelInfo: async () => capabilities("user-alias", "gpt-6-sol", ["low"]), ...guardianStream('{"outcome":"allow"}') },
  });
  assert.equal(rejected.kind, "deny");
  assert.deepEqual(rejected.failure, { stage: "schema", code: "INVALID_SCHEMA", httpStatus: null, finishReason: null });
});

test("Codex 回答不合协议时按 parse/schema 分类拒绝，失败不放行", async () => {
  const cases = [
    ["allow", "parse", "INVALID_JSON"],
    ['```json\n{"outcome":"allow"}\n```', "parse", "INVALID_JSON"],
    ['{"action":"allow"}', "schema", "INVALID_SCHEMA"],
    ['{"outcome":"allow","risk_level":"extreme"}', "schema", "INVALID_SCHEMA"],
    ['{"outcome":"allow","user_authorization":1}', "schema", "INVALID_SCHEMA"],
    ['{"outcome":"allow","extra":true}', "schema", "INVALID_SCHEMA"],
  ];
  for (const [text, stage, code] of cases) {
    const llm = { resolveModelInfo: async () => codexInfo(), ...guardianStream(text) };
    const result = await reviewWithFallback({ ...base, config: codexRoute("low"), llm });
    assert.equal(result.kind, "deny", `不能因为 ${text} 放行`);
    assert.equal(result.reason, "fallback-review-failed");
    assert.deepEqual(result.failure, { stage, code, httpStatus: null, finishReason: null });
    assert.doesNotMatch(JSON.stringify(result), /private-.*-canary/);
  }

  const truncated = await reviewWithFallback({
    ...base,
    config: codexRoute("low"),
    llm: { resolveModelInfo: async () => codexInfo(), ...guardianStream('{"outcome":"allow"}', "max-tokens") },
  });
  assert.equal(truncated.kind, "deny");
  assert.deepEqual(truncated.failure, { stage: "finish", code: "NON_STOP_FINISH", httpStatus: null, finishReason: "max-tokens" });
});

test("Codex 路由同样受 mandatory 约束，不查能力也不请求模型", async () => {
  let resolved = 0;
  let streams = 0;
  const llm = {
    resolveModelInfo: async () => { resolved += 1; return codexInfo(); },
    stream() { streams += 1; throw new Error("must not stream"); },
  };
  const result = await reviewWithFallback({ ...base, config: codexRoute("low"), mandatory: { status: "requires_approval" }, llm });
  assert.equal(result.kind, "deny");
  assert.equal(result.reason, "mandatory-policy-protected");
  assert.equal(resolved, 0);
  assert.equal(streams, 0);
});
