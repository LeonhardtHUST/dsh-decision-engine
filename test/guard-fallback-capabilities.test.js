import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { preflightFallbackCapabilities } from "../lib/guard/fallback-capabilities.js";

const selection = { provider: "host", model: "review" };
const info = (efforts, extra = {}) => ({
  provider: "host",
  id: "review",
  name: "Review",
  reasoning: { efforts: efforts.map((id) => ({ id, name: id.toUpperCase() })) },
  ...extra,
});
const incompatible = {
  status: "incompatible",
  failure: { stage: "selection", code: "UNSUPPORTED_REASONING_EFFORT", httpStatus: null, finishReason: null },
};

test("没有显式档位不查能力目录，也不替调用方挑最小值", async () => {
  let calls = 0;
  const result = await preflightFallbackCapabilities({
    llm: { resolveModelInfo() { calls += 1; throw new Error("must not query"); } },
    selection,
  });
  assert.deepEqual(result, { status: "host-default" });
  assert.equal(calls, 0);
  assert.equal((await preflightFallbackCapabilities({ llm: {}, selection: { ...selection, reasoningEffort: "" } })).status, "host-default");
});

test("旧宿主没有 resolveModelInfo 时保留原 SDK 验证路径，不冒充预检通过", async () => {
  const result = await preflightFallbackCapabilities({ llm: { stream() {} }, selection: { ...selection, reasoningEffort: "high" } });
  assert.deepEqual(result, { status: "legacy-sdk-validation" });
});

test("显式档位按 exact model 的 efforts 核对，off 也走同一规则", async () => {
  const calls = [];
  const llm = { async resolveModelInfo(provider, model, signal) { calls.push({ provider, model, signal }); return info(["off", "low", "high"]); } };
  const controller = new AbortController();
  for (const effort of ["off", "low", "high"]) {
    const result = await preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: effort }, signal: controller.signal });
    assert.deepEqual(result, { status: "supported" });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { provider: "host", model: "review", signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("能力目录不长期缓存：元数据变化后下一次预检必须重新查询", async () => {
  let version = 0;
  const llm = {
    async resolveModelInfo() {
      version += 1;
      return version === 1 ? info(["low"]) : info(["high"]);
    },
  };
  assert.deepEqual(await preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: "low" } }), { status: "supported" });
  assert.deepEqual(await preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: "low" } }), incompatible);
});

test("不支持的显式档位返回固定原因，不携带任何原文", async () => {
  const llm = { async resolveModelInfo() { return info(["low", "high"]); } };
  for (const effort of ["off", "medium", "HIGH"]) {
    const result = await preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: effort } });
    assert.deepEqual(result, incompatible);
  }
});

test("没有 reasoning 元数据时不捏造 supported，按宿主口径判为不支持", async () => {
  const llm = { async resolveModelInfo() { return { provider: "host", id: "review", name: "Review" }; } };
  assert.deepEqual(await preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: "high" } }), incompatible);
});

test("元数据非法时保守失败，且只保留白名单分类", async () => {
  const canary = "private-metadata-canary-https://secret.invalid/?token=fixture";
  const invalid = [
    undefined,
    null,
    [],
    { provider: "host", id: "review" },
    { provider: "other", id: "review", name: "Review", reasoning: { efforts: [{ id: "high", name: "High" }] } },
    { provider: "host", id: "other", name: "Review", reasoning: { efforts: [{ id: "high", name: "High" }] } },
    { provider: "host", id: "review", name: "Review", reasoning: {} },
    { provider: "host", id: "review", name: "Review", reasoning: { efforts: [] } },
    { provider: "host", id: "review", name: "Review", reasoning: { efforts: [{ id: "high" }] } },
    { provider: "host", id: "review", name: "Review", reasoning: { efforts: [{ id: "high", name: "High" }, { id: "high", name: "Again" }] } },
    { provider: "host", id: "review", name: "Review", reasoning: { efforts: [{ id: "low", name: "Low" }], defaultEffort: canary } },
  ];
  for (const value of invalid) {
    const result = await preflightFallbackCapabilities({ llm: { async resolveModelInfo() { return value; } }, selection: { ...selection, reasoningEffort: "high" } });
    assert.equal(result.status, "unverifiable");
    assert.equal(result.failure.stage, "selection");
    assert.equal(result.failure.httpStatus, null);
    assert.equal(result.failure.finishReason, null);
    assert.ok(!JSON.stringify(result).includes(canary));
  }
});

test("查询抛错只带白名单 code，不回显异常或密钥", async () => {
  const canary = "private-capability-canary-https://secret.invalid/?token=fixture";
  const cases = [
    { code: "INVALID_MODEL_REASONING", expected: "INVALID_MODEL_REASONING" },
    { code: "INVALID_MODEL_INFO", expected: "INVALID_MODEL_INFO" },
    { code: canary, expected: "UNKNOWN" },
    { code: undefined, expected: "UNKNOWN" },
  ];
  for (const { code, expected } of cases) {
    const error = Object.assign(new Error(canary), { code, failure: { code, status: 401, message: canary, headers: canary } });
    const result = await preflightFallbackCapabilities({ llm: { async resolveModelInfo() { throw error; } }, selection: { ...selection, reasoningEffort: "high" } });
    assert.equal(result.status, "unverifiable");
    assert.deepEqual(result.failure, { stage: "selection", code: expected, httpStatus: null, finishReason: null });
    assert.ok(!JSON.stringify(result).includes(canary));
  }
});

test("适配器直接报不支持档位时归入同一个固定 failure", async () => {
  const error = Object.assign(new Error("unsupported"), { code: "UNSUPPORTED_REASONING_EFFORT" });
  const result = await preflightFallbackCapabilities({ llm: { async resolveModelInfo() { throw error; } }, selection: { ...selection, reasoningEffort: "max" } });
  assert.deepEqual(result, incompatible);
});

test("查询永不返回时由调用方信号取消，且清理 abort 监听", async () => {
  const controller = new AbortController();
  const llm = { resolveModelInfo: () => new Promise(() => {}) };
  const pending = preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: "high" }, signal: controller.signal });
  controller.abort(new Error("private-abort-canary"));
  await assert.rejects(pending, /private-abort-canary/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("信号已取消时不发起查询", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("fixture-pre-aborted"));
  await assert.rejects(
    preflightFallbackCapabilities({ llm: { resolveModelInfo() { calls += 1; } }, selection: { ...selection, reasoningEffort: "high" }, signal: controller.signal }),
    /fixture-pre-aborted/,
  );
  assert.equal(calls, 0);
});

test("迟到返回的元数据在取消后不再产生 supported 结论", async () => {
  const controller = new AbortController();
  let release;
  const llm = { resolveModelInfo: () => new Promise((resolve) => { release = resolve; }) };
  const pending = preflightFallbackCapabilities({ llm, selection: { ...selection, reasoningEffort: "high" }, signal: controller.signal });
  controller.abort(new Error("fixture-cancel"));
  await assert.rejects(pending, /fixture-cancel/);
  release(info(["high"]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
