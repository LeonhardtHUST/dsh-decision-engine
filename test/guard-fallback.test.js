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

test("外部审查前遮盖常见密钥字段和bearer值", () => {
  assert.deepEqual(redactGuardData({ apiKey: "123", args: { token: "456" }, text: "Bearer abcdefghijklmnop" }), { apiKey: "[redacted]", args: { token: "[redacted]" }, text: "[redacted]" });
});
