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

/**
 * Codex guardian 路由：provider 是用户自定义别名，协议只能由 exact model id
 * 决定，所以这里刻意不用 `codex-proxy`。
 */
const codexConfig = (effort = "") =>
  "enabled: true\n"
  + "guardFallback: model\n"
  + "guardFallbackProvider: user-alias\n"
  + "guardFallbackModel: codex-auto-review\n"
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
    // 普通模型回归：仍是 pong 探针，不注入 guardian 的 system，也不抬高输出预算。
    assert.equal(Object.hasOwn(request, "system"), false, "普通模型不能带上守护 system");
    assert.equal(request.maxTokens, 16);
    assert.equal(request.messages[0].content[0].text, "Reply with the single word: pong");
    assert.match(fallback.summary, /响应: pong/);
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

test("连接性测试对 Codex guardian 发送审查协议 system、解析 outcome 且不返显 rationale", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const canary = "private-rationale-canary";
  let request;
  const env = setup(mod, {
    llm: {
      async resolveModelInfo(provider, model) {
        assert.equal(provider, "user-alias");
        assert.equal(model, "codex-auto-review");
        return modelInfo(provider, model, ["low", "medium", "high"]);
      },
      stream(options) {
        request = options;
        return (async function* () {
          yield { type: "text-delta", text: `{"outcome":"allow","risk_level":"low","rationale":"${canary}"}` };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    configText: codexConfig("low"),
  });
  try {
    const data = await env.click();
    assert.equal(data.ok, true, `guardian 探针应通过：${JSON.stringify(data)}`);
    const fallback = data.results.find((item) => item.key === "fallback");
    assert.equal(fallback.ok, true);
    assert.equal(request.provider, "user-alias", "provider 别名原样透传，不换成 codex-proxy");
    assert.equal(request.model, "codex-auto-review");
    assert.equal(request.reasoningEffort, "low", "不能静默换档位");
    assert.equal(request.purpose, "decision-engine-connectivity");
    // 与回退审查同一份 system，且要求 outcome 形状。
    assert.match(request.system, /"outcome"/);
    assert.match(request.system, /"risk_level"/);
    assert.match(request.system, /"user_authorization"/);
    // guardian 的 JSON 放不进 16 token。
    assert.ok(request.maxTokens >= 256, `guardian 探针的输出预算过小：${request.maxTokens}`);
    assert.deepEqual(request.tools, []);
    const prompt = request.messages[0].content[0].text;
    assert.match(prompt, /Connectivity fixture, not a real tool call/);
    assert.match(prompt, /"outcome":"allow"/);
    assert.doesNotMatch(prompt, /pwsh|write|edit|file_path|command/, "探针不能带真实工具内容");
    assert.match(fallback.summary, /守护协议: codex-guardian/);
    assert.match(fallback.summary, /outcome: allow/);
    assert.match(fallback.summary, /risk_level: low/);
    assert.ok(!JSON.stringify(data).includes(canary), "rationale 是模型自由文本，不得返显");
  } finally {
    env.restore();
  }
});

test("连接性测试按 guardian 回答的 outcome 显示 deny，不带多余键时 risk_level 标未声明", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  let request;
  const env = setup(mod, {
    llm: {
      async resolveModelInfo(provider, model) { return modelInfo(provider, model, ["low"]); },
      stream(options) {
        request = options;
        return (async function* () {
          // 最小合法形状：只有 outcome，没有 risk_level / rationale。
          yield { type: "text-delta", text: "{\"outcome\":\"deny\"}" };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    configText: codexConfig("low"),
  });
  try {
    const data = await env.click();
    const fallback = data.results.find((item) => item.key === "fallback");
    assert.equal(data.ok, true, `guardian 的 deny 也是合法回答：${JSON.stringify(data)}`);
    assert.equal(fallback.ok, true, "deny 只说明模型做出了审查结论，不是连通性故障");
    assert.equal(request.system.includes("\"outcome\""), true);
    assert.match(fallback.summary, /守护协议: codex-guardian/);
    assert.match(fallback.summary, /outcome: deny/, "按模型实际 outcome 显示，不能擅自改成 allow");
    assert.match(fallback.summary, /risk_level: 未声明/);
  } finally {
    env.restore();
  }
});

test("Codex guardian 回答不合协议或没有正常结束时给固定诊断，不回显正文", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const canary = "private-guardian-canary";
  const scenarios = [
    { name: "prose", text: `allow ${canary}`, finish: "stop", expected: /不是单个 guardian JSON 对象/ },
    { name: "fence", text: `\`\`\`json\n{"outcome":"allow"}\n\`\`\``, finish: "stop", expected: /不是单个 guardian JSON 对象/ },
    { name: "action-mix", text: `{"action":"allow","rationale":"${canary}"}`, finish: "stop", expected: /不是单个 guardian JSON 对象/ },
    { name: "truncated", text: `{"outcome":"allow","rationale":"${canary}"}`, finish: "length", expected: /没有以正常结束（stop）返回 guardian JSON/ },
  ];
  for (const scenario of scenarios) {
    let request;
    const env = setup(mod, {
      llm: {
        async resolveModelInfo(provider, model) { return modelInfo(provider, model, ["low"]); },
        stream(options) {
          request = options;
          return (async function* () {
            yield { type: "text-delta", text: scenario.text };
            yield { type: "finish", reason: { kind: scenario.finish } };
          })();
        },
      },
      configText: codexConfig("low"),
    });
    try {
      const data = await env.click();
      const fallback = data.results.find((item) => item.key === "fallback");
      assert.equal(data.ok, false, `${scenario.name} 不能报绿`);
      assert.equal(fallback.ok, false);
      assert.match(fallback.summary, /未通过协议解析/);
      assert.match(fallback.summary, scenario.expected);
      assert.equal(request.system.includes("outcome"), true, "仍然走 guardian 协议");
      assert.ok(!JSON.stringify(data).includes(canary), `${scenario.name} 不得回显模型正文`);
    } finally {
      env.restore();
    }
  }
});

test("Codex guardian 探针传输异常不回显错误正文", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const canary = "private-guardian-transport-canary";
  const env = setup(mod, {
    llm: {
      async resolveModelInfo(provider, model) { return modelInfo(provider, model, ["low"]); },
      stream() { throw new Error(canary); },
    },
    configText: codexConfig("low"),
  });
  try {
    const data = await env.click();
    const fallback = data.results.find((item) => item.key === "fallback");
    assert.equal(data.ok, false);
    assert.equal(fallback.ok, false);
    assert.match(fallback.summary, /guardian 审查探针未完成/);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(canary));
  } finally {
    env.restore();
  }
});
test("普通模型的 pong 探针仍接受 length 截断，行为不因 guardian 分支改变", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  let request;
  const env = setup(mod, {
    llm: {
      async resolveModelInfo(provider, model) { return modelInfo(provider, model, ["high"]); },
      stream(options) {
        request = options;
        return (async function* () {
          yield { type: "text-delta", text: "pon" };
          yield { type: "finish", reason: { kind: "length" } };
        })();
      },
    },
    configText: baseConfig("high"),
  });
  try {
    const data = await env.click();
    const fallback = data.results.find((item) => item.key === "fallback");
    assert.equal(data.ok, true);
    assert.equal(fallback.ok, true, "普通模型 16 token 截断仍算连通");
    assert.match(fallback.summary, /finish: length/);
    assert.match(fallback.summary, /响应: pon/);
    assert.equal(Object.hasOwn(request, "system"), false);
  } finally {
    env.restore();
  }
});
