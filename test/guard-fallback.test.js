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
