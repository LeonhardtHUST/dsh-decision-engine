import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 设置页连接性测试的隔离环境。
 *
 * 与 engine.test.js 的 probeSetup 同构，但这里只关心回退语言模型这一条链路：
 * 决策端点用成功桩，避免任何真实网络请求；`llm` 由用例注入，用来观察
 * `resolveModelInfo` 与 `stream` 是否被调用。
 */
async function loadIndexModule(t) {
  try {
    return await import("../lib/index.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("缺少宿主 peer 依赖 @deepseek-ai/schemastery，跳过连接性集成用例");
      return undefined;
    }
    throw error;
  }
}

const okResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => undefined },
  async json() { return { answers: { alive: { type: "noul", noul: 0.9 } }, model: "test-model" }; },
  async text() { return "{}"; },
});

function setup(mod, { llm, configText }) {
  const home = mkdtempSync(join(tmpdir(), "de-capabilities-"));
  const originalHome = process.env.DSH_HOME;
  const originalKey = process.env.BAMBOO_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  process.env.BAMBOO_API_KEY = "connectivity-test-key";
  if (typeof configText === "string") {
    const dir = join(home, "dsh-decision-engine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yml"), configText, "utf8");
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes("/decisions") || String(url).includes("/systemone")) return okResponse();
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } };
  };
  const routes = {};
  const hooks = new Map();
  const connection = { fetch: { register(entry) { routes[entry.path] = entry; } } };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) { const list = hooks.get(name) ?? []; list.push(listener); hooks.set(name, list); return () => {}; },
    get(name) {
      if (name === "connection") return connection;
      if (name === "llm") return llm;
      if (name === "sandboxPolicy") return { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/work/repo", additionalWritableRoots: [] }) };
      if (name === "fs") return {
        resolve: async (path, options) => ({ targetKey: path }),
        contains: (root, target) => target.targetKey === root.targetKey || target.targetKey.startsWith(`${root.targetKey}/`),
      };
      return undefined;
    },
    inject(_names, fn) { fn(); },
    plugin() {},
    effect() {},
  };
  mod.apply(ctx, {});
  return {
    async click() {
      const res = await routes["/api/decision-engine/test"].fetch({ method: "POST", url: "http://localhost/api/decision-engine/test" });
      return res.json();
    },
    restore() {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = originalHome;
      if (originalKey === undefined) delete process.env.BAMBOO_API_KEY;
      else process.env.BAMBOO_API_KEY = originalKey;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try { rmSync(home, { recursive: true, force: true }); return; }
        catch (error) {
          if (error?.code === "ENOENT") return;
          if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* 清理失败不影响用例结论 */ }
    },
  };
}

const modelInfo = (provider, model, efforts) => ({
  provider,
  id: model,
  name: "Fixture",
  reasoning: { efforts: efforts.map((id) => ({ id, name: id.toUpperCase() })) },
});

const baseConfig = (effort = "") =>
  "enabled: true\n"
  + "guardFallback: model\n"
  + "guardFallbackProvider: fixture-provider\n"
  + "guardFallbackModel: fixture-model\n"
  + (effort.length > 0 ? `guardFallbackReasoningEffort: ${effort}\n` : "");

test("连接性测试对不支持的显式档位给固定可操作提示且零stream", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  let streams = 0;
  let resolved = 0;
  const env = setup(mod, {
    llm: {
      async resolveModelInfo() { resolved += 1; return modelInfo("fixture-provider", "fixture-model", ["low", "high"]); },
      stream() { streams += 1; throw new Error("stream must not start"); },
    },
    configText: baseConfig("max"),
  });
  try {
    const data = await env.click();
    assert.equal(data.ok, false, "档位不支持时整体测试不能报绿");
    const fallback = data.results.find((item) => item.key === "fallback");
    assert.equal(fallback.ok, false);
    assert.match(fallback.summary, /未发起模型请求/);
    assert.match(fallback.summary, /该模型不支持所配置的思考档位/);
    assert.match(fallback.summary, /请在设置中选择该模型实际支持的档位/);
    assert.match(fallback.summary, /未自动更换模型或档位/);
    assert.equal(resolved, 1, "能力预检应查询一次 exact model 元数据");
    assert.equal(streams, 0, "不支持的档位绝不能发出模型请求");
  } finally {
    env.restore();
  }
});

test("连接性测试对受支持的显式档位沿用同一信号与原始route/effort", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  let resolveSignal;
  let request;
  const env = setup(mod, {
    llm: {
      async resolveModelInfo(provider, model, signal) {
        assert.equal(provider, "fixture-provider");
        assert.equal(model, "fixture-model");
        resolveSignal = signal;
        return modelInfo(provider, model, ["off", "low", "high", "max"]);
      },
      stream(options) {
        request = options;
        return (async function* () {
          yield { type: "text-delta", text: "pong" };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    configText: baseConfig("max"),
  });
  try {
    const data = await env.click();
    assert.equal(data.ok, true, `受支持时应测试通过：${JSON.stringify(data)}`);
    const fallback = data.results.find((item) => item.key === "fallback");
    assert.equal(fallback.ok, true);
    assert.equal(request.provider, "fixture-provider");
    assert.equal(request.model, "fixture-model");
    assert.equal(request.reasoningEffort, "max", "不能静默换成别的档位");
    assert.equal(request.signal, resolveSignal, "能力预检与真实请求必须共享同一个超时信号");
    assert.equal(request.purpose, "decision-engine-connectivity");
  } finally {
    env.restore();
  }
});

test("连接性测试对非法或抛错的元数据只给固定分类，不回显异常", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const canary = "private-connectivity-canary-https://secret.invalid/?token=fixture";
  for (const scenario of ["throw", "missing-name"]) {
    let streams = 0;
    const llm = scenario === "throw"
      ? {
        async resolveModelInfo() { throw Object.assign(new Error(canary), { code: canary, failure: { code: canary, status: 401, headers: canary } }); },
        stream() { streams += 1; throw new Error("stream must not start"); },
      }
      : {
        async resolveModelInfo() { return { provider: "fixture-provider", id: "fixture-model" }; },
        stream() { streams += 1; throw new Error("stream must not start"); },
      };
    const env = setup(mod, { llm, configText: baseConfig("high") });
    try {
      const data = await env.click();
      const fallback = data.results.find((item) => item.key === "fallback");
      assert.equal(data.ok, false);
      assert.equal(fallback.ok, false);
      assert.match(fallback.summary, /未发起模型请求：无法确认该模型的思考档位能力/);
      assert.match(fallback.summary, /请检查宿主模型服务与模型标识后重试/);
      if (scenario === "throw") assert.match(fallback.summary, /（UNKNOWN）/);
      else assert.match(fallback.summary, /（INVALID_MODEL_INFO）/);
      assert.equal(streams, 0);
      assert.ok(!JSON.stringify(data).includes(canary), "不得回显异常原文或密钥");
    } finally {
      env.restore();
    }
  }
});

test("连接性测试在无显式档位时不查能力、不挑最小档位，交宿主默认", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  let resolved = 0;
  let request;
  const env = setup(mod, {
    llm: {
      async resolveModelInfo() { resolved += 1; return modelInfo("fixture-provider", "fixture-model", ["low"]); },
      stream(options) {
        request = options;
        return (async function* () {
          yield { type: "text-delta", text: "pong" };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    configText: baseConfig(),
  });
  try {
    const data = await env.click();
    assert.equal(data.ok, true);
    assert.equal(resolved, 0, "没有显式档位时不应该为了预检去查能力");
    assert.equal(Object.hasOwn(request, "reasoningEffort"), false, "不能替调用方补一个档位");
  } finally {
    env.restore();
  }
});
