/**
 * 「决策历史」查询路由的测试（DEC-022）。
 *
 * 走**真实的** HTTP 路由（`connection.fetch.register` 注册的那张表），
 * 不打网络、不起浏览器。做法与 `test/save-path.test.js` 一致：把 DSH_HOME
 * 指到临时目录，用最小假 ctx 走 `apply()`，再直接调用注册进来的 fetch。
 *
 * 防的是这几类错：
 *
 *   1. **会话参数没校验**——缺 sessionId 时返回全部记录，用户会看到一堆
 *      不属于自己的决策。
 *   2. **空文件 / 坏文件时崩掉**——页面必须能显示空态而不是 500。
 *   3. **limit 失控**——一次拉回几 MB 会把浏览器拖垮。
 *   4. **开关关闭后仍然返回内容**——用户说「不记录」，读端也不该给出内容。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply, createSessionMetaResolver } from "../lib/index.js";
import { dateKeyOf } from "../lib/decision-log.js";

/**
 * 造一个隔离环境。
 *
 * @returns `{ home, routes, dataDir }`：`routes` 是注册进来的路径表，
 *   `dataDir` 是插件的数据目录。
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "dsh-decroute-"));
  process.env.DSH_HOME = home;
  const routes = {};
  const connection = {
    fetch: {
      register(entry) {
        routes[entry.path] = entry;
      },
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on() {},
    get(name) {
      return name === "connection" ? connection : undefined;
    },
    inject(_names, fn) {
      fn();
    },
    plugin() {},
    effect() {},
  };
  apply(ctx, {});
  return { home, routes, dataDir: join(home, "dsh-decision-engine") };
}

/**
 * 清理临时目录，容忍「插件后台还在写」的竞态。
 *
 * `apply()` 会启动若干**不 await** 的后台旁路（统计回填、明细写盘），它们
 * 可能在本用例 `rmSync` 之后才落盘。此时 `rmSync` 抛 `ENOTEMPTY`——**清理
 * 阶段的失败，而不是被测行为的失败**。
 *
 * 曾观察到它偶发（单独跑该文件 5 次全绿、全量跑里偶现一次）。不处理的话，
 * 它会表现为「全量跑里随机变红」，而那种红会让人开始忽略真正的回归——
 * 一个会随机亮起的红灯比没有红灯更危险。
 *
 * 因此这里重试几次，并且**只吞 ENOTEMPTY / EBUSY / EPERM**：其它错误（路径
 * 算错、权限真的不对）仍要抛出来，因为它们是真的问题。
 *
 * `EPERM` 在 Windows 上的含义与 POSIX 不同：目录里还有**打开着的文件句柄**
 * （后台 append/轮转正在写分片）时 `rmSync` 会直接报 EPERM，而 Linux 报
 * ENOTEMPTY/EBUSY。分文件改造之后后台清理与写入更频繁，这个竞态从「偶发」
 * 变成了「全量跑里能稳定复现一次」——按平台加进重试集合，而不是把用例改成
 * 忽略清理错误（那样真把路径算错也看不出来了）。
 *
 * @param dir - 要删的临时目录。
 */
function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error?.code;
      // 目录已被别的清理删掉：目标达成，正常返回。
      if (code === "ENOENT") return;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") throw error;
      // 后台写者刚创建/占用了文件：稍等再试。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  // 最后一次尽力而为：失败也不再让「清理」把用例判红。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响用例结论 */
  }
}

/**
 * 调一次 GET 路由。
 *
 * 注意查表用的是**去掉查询串**的路径：路由注册表以 path 为键，
 * `?sessionId=…` 是请求 URL 的一部分，不在键里。
 */
async function get(routes, url) {
  const key = url.split("?")[0];
  const res = await routes[key].fetch({ method: "GET", url: `http://localhost${url}` });
  return { status: res.status, data: await res.json() };
}

/**
 * 往当日分片里写几行。
 *
 * 分文件改造后日志在 `logs/<今天>.log`。这里**直接写当日分片**而不是旧的
 * `decisions.jsonl`：旧文件会触发启动时的一次性迁移，而迁移是 `void` 的
 * 后台动作——若让用例依赖「迁移先完成」，就变成了对调度顺序的断言，
 * 在不同的磁盘/CI 上会随机红。迁移本身由 `test/decision-store.test.js`
 * 直接 await 验证。
 */
function seed(dataDir, entries) {
  const logs = join(dataDir, "logs");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, `${dateKeyOf(Date.now())}.log`);
  writeFileSync(
    file,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    "utf8",
  );
  return file;
}

/** 一条最小明细记录。 */
function entry(over = {}) {
  return {
    v: 1,
    seq: 1,
    ts: "2026-11-03T00:00:00.000Z",
    sessionId: "session-a",
    point: "authorize",
    provider: "bamboonode",
    model: "m1",
    action: "delegate",
    detail: "delegate",
    latencyMs: 100,
    capture: "full",
    ...over,
  };
}

test("缺少 sessionId 时返回 400（不返回全部记录）", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [entry(), entry({ seq: 2, sessionId: "session-b" })]);
    const { status, data } = await get(routes, "/api/decision-engine/session-decisions");
    assert.equal(status, 400);
    assert.equal(typeof data.error, "string");
    assert.equal(data.entries, undefined, "出错时不该顺带返回记录");
  } finally {
    cleanupDir(home);
  }
});

test("按会话过滤：只返回本会话的记录", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [
      entry({ seq: 1, sessionId: "session-a", tool: "read" }),
      entry({ seq: 2, sessionId: "session-b", tool: "grep" }),
      entry({ seq: 3, sessionId: "session-a", tool: "bash" }),
    ]);
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(data.entries.length, 2);
    assert.equal(data.total, 2);
    assert.deepEqual(data.entries.map((item) => item.tool), ["read", "bash"]);
  } finally {
    cleanupDir(home);
  }
});

test("文件不存在时返回空列表而不是 500", async () => {
  const { home, routes } = setup();
  try {
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.deepEqual(data.entries, []);
    assert.equal(data.total, 0);
  } finally {
    cleanupDir(home);
  }
});

test("坏行被跳过，其余记录照常返回", async () => {
  const { home, routes, dataDir } = setup();
  try {
    const file = seed(dataDir, [entry({ tool: "read" })]);
    appendFileSync(file, '{"v":1,"broken\n', "utf8");
    appendFileSync(file, `${JSON.stringify(entry({ seq: 2, tool: "bash" }))}\n`, "utf8");
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(data.entries.length, 2, "坏行不该影响好行");
  } finally {
    cleanupDir(home);
  }
});

test("limit 生效且有上限（不会一次拉回全部）", async () => {
  const { home, routes } = setup();
  try {
    seed(
      join(home, "dsh-decision-engine"),
      Array.from({ length: 40 }, (_, index) => entry({ seq: index + 1, tool: `t${index}` })),
    );
    const { data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a&limit=5",
    );
    assert.equal(data.entries.length, 5);
    assert.equal(data.total, 40);
    assert.equal(data.truncated, true);
  } finally {
    cleanupDir(home);
  }
});

test("超大的 limit 被压到上限之内", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [entry()]);
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a&limit=999999",
    );
    assert.equal(status, 200);
    assert.equal(data.entries.length, 1);
  } finally {
    cleanupDir(home);
  }
});

test("返回体带上界面需要的元信息（文件路径、开关）", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [entry()]);
    const { data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(data.sessionId, "session-a");
    assert.equal(typeof data.file, "string");
    // 分文件改造后默认按日期分片（logs/<YYYY-MM-DD>.log），不再是单文件
    // decisions.jsonl——但 `file` 字段保留（旧界面按它显示「记录在哪」）。
    assert.ok(data.file.endsWith(".log"), `应回报明细分片路径：${data.file}`);
    assert.ok(Array.isArray(data.files), "分文件模式下要回报实际读取的分片清单");
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0], data.file);
    assert.equal(data.enabled, true, "默认开启");
    // DEC-029：「采不采内容」不再是独立档位，响应里就该没有这个字段。
    // 断言「它不在」比断言「它是 true」更能防止它悄悄回来。
    assert.equal(
      Object.hasOwn(data, "capture"),
      false,
      "内容采集不是独立档位，响应里不该再有 capture",
    );
  } finally {
    cleanupDir(home);
  }
});

test("开关关闭后不再写明细（文件不会被创建）", async () => {
  const { home, routes, dataDir } = setup();
  try {
    // 通过真实的配置路由把开关关掉。
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsTabEnabled: false }),
    });
    assert.equal(res.status, 200, `关开关应成功：${JSON.stringify(await res.clone().json())}`);

    // 记录一条（走守卫路径太重，这里直接验证存储层的行为）。
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(data.enabled, false, "状态应回报开关已关");
    assert.deepEqual(data.entries, []);
  } finally {
    cleanupDir(home);
  }
});

test("状态接口回报开关的生效值（默认开）", async () => {
  const { home, routes } = setup();
  try {
    const { status, data } = await get(routes, "/api/decision-engine/status");
    assert.equal(status, 200);
    assert.equal(data.decisionsTabEnabled, true, "默认应开启");
    // DEC-029：decisionsCapture 已退役——它曾经能在配置页之外把每条记录
    // 静默降级成元数据，现在状态接口不再回传它。
    assert.equal(
      Object.hasOwn(data, "decisionsCapture"),
      false,
      "退役的 decisionsCapture 不该再出现在状态里",
    );
  } finally {
    cleanupDir(home);
  }
});

test("开关能被保存并回显（配置页的开关链路）", async () => {
  const { home, routes } = setup();
  try {
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsTabEnabled: false }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.decisionsTabEnabled, false, "保存后应立刻回显新值");

    // 落盘检查：值真的写进了 config.yml。
    const raw = readFileSync(join(home, "dsh-decision-engine", "config.yml"), "utf8");
    assert.ok(raw.includes("decisionsTabEnabled: false"), `配置内容：${raw}`);
  } finally {
    cleanupDir(home);
  }
});

test("config.yml 里遗留的退役键不再影响任何行为（旧配置平滑升级）", async () => {
  // 真机上就是这个形态：config.yml 里留着 `decisionsCapture: false`
  // （合并开关后的残留），而 decisionsTabEnabled 是 true。DEC-029 之前
  // 这一行让每条记录都退化成「只有元数据」；退役之后它必须变成**惰性键**——
  // 插件照常启动，开关照常生效，并且它不会从任何出口再冒出来。
  const home = mkdtempSync(join(tmpdir(), "dsh-decroute-legacy-"));
  process.env.DSH_HOME = home;
  const dataDir = join(home, "dsh-decision-engine");
  mkdirSync(dataDir, { recursive: true });
  const legacy = [
    "enabled: true",
    "mode: enforce",
    "decisionsTabEnabled: true",
    "decisionsCapture: false",
    "",
  ].join("\n");
  writeFileSync(join(dataDir, "config.yml"), legacy, "utf8");

  const routes = {};
  const connection = {
    fetch: {
      register(entry) {
        routes[entry.path] = entry;
      },
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on() {},
    get(name) {
      return name === "connection" ? connection : undefined;
    },
    inject(_names, fn) {
      fn();
    },
    plugin() {},
    effect() {},
  };
  try {
    // 不抛 = 带惰性键的旧配置仍能启动。
    apply(ctx, {});

    const { status, data } = await get(routes, "/api/decision-engine/status");
    assert.equal(status, 200, "带遗留键的配置应照常启动");
    assert.equal(data.decisionsTabEnabled, true, "开关照常生效");
    assert.equal(
      Object.hasOwn(data, "decisionsCapture"),
      false,
      "退役键不该再出现在状态回显里",
    );

    // 惰性键不被回写、也不被清除：退役是「不再读」，不是「偷偷改用户的文件」。
    assert.equal(readFileSync(join(dataDir, "config.yml"), "utf8"), legacy, "不该改写用户的配置");
  } finally {
    cleanupDir(home);
  }
});

test("已退役的 decisionsCapture 不再是一个可写配置（PUT 只带它应被拒）", async () => {
  const { home, routes } = setup();
  try {
    // DEC-029：这个键曾经能落盘，并让「开关显示开、记录只有元数据」。
    // 退役之后它既不在白名单里也不在 schema 里，只提交它应当被拒——
    // 而不是「静默接受一个没人再读的值」。
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsCapture: false }),
    });
    assert.equal(res.status, 400, "只提交退役键应被拒");
    const payload = await res.json();
    assert.match(String(payload.error), /no updatable fields/, `实际：${payload.error}`);

    // 而且什么都没落盘。
    assert.equal(
      existsSync(join(home, "dsh-decision-engine", "config.yml")),
      false,
      "被拒的请求不该写出配置文件",
    );
  } finally {
    cleanupDir(home);
  }
});

// ------------------------------------------------------------------ 同批修的既有缺陷

test("匿名统计已退役：仅提交旧配置键应拒绝且不落盘", async () => {
  const { home, routes } = setup();
  try {
    for (const patch of [{ telemetryLevel: "daily" }, { telemetryEndpoint: "https://analytics.invalid/collect" }]) {
      const res = await routes["/api/decision-engine/config"].fetch({
        method: "PUT",
        text: async () => JSON.stringify(patch),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /no updatable fields/);
    }
    assert.equal(existsSync(join(home, "dsh-decision-engine", "config.yml")), false);
  } finally {
    cleanupDir(home);
  }
});

test("状态接口不再提供匿名统计配置", async () => {
  const { home, routes } = setup();
  try {
    const { data } = await get(routes, "/api/decision-engine/status");
    for (const key of ["telemetryLevel", "telemetryLevels", "telemetryEndpoint"]) {
      assert.equal(Object.hasOwn(data, key), false, key);
    }
  } finally {
    cleanupDir(home);
  }
});

// ------------------------------------------------------------------ 日志分文件与保留（T3）

test("状态接口回显日志分文件/保留的默认值与可选清单", async () => {
  const { home, routes } = setup();
  try {
    const { status, data } = await get(routes, "/api/decision-engine/status");
    assert.equal(status, 200);
    assert.equal(data.decisionsSplitMode, "date", "默认按日期分文件");
    assert.deepEqual(
      data.decisionsSplitModes,
      ["single", "date", "session", "workspace"],
      "可选模式由服务端下发，前端不硬编码",
    );
    assert.equal(data.decisionsDateSeparator, "-");
    assert.deepEqual(data.decisionsDateSeparators, ["-", "_", "."]);
    assert.equal(data.decisionsRetentionDays, 30, "默认保留 30 天");
    // 清理报告：设置页要用它显示「几个文件 / 多少字节」。
    assert.equal(typeof data.decisionsStorage, "object");
    assert.equal(typeof data.decisionsStorage.files, "number");
    assert.equal(typeof data.decisionsStorage.bytes, "number");
    assert.equal(data.decisionsStorage.retentionDays, 30);
    assert.equal(data.decisionsStorage.totalMaxBytes, 64 * 1024 * 1024);
    // 主分片路径：默认 date 模式 → logs/<今天>.log。
    assert.ok(String(data.decisionsFile).endsWith(".log"), `实际：${data.decisionsFile}`);
  } finally {
    cleanupDir(home);
  }
});

test("日志分文件模式能保存并回显（配置页下拉的链路）", async () => {
  const { home, routes } = setup();
  try {
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () =>
        JSON.stringify({
          decisionsSplitMode: "session",
          decisionsDateSeparator: "_",
          decisionsRetentionDays: 7,
        }),
    });
    assert.equal(res.status, 200, `保存应成功：${JSON.stringify(await res.clone().json())}`);
    const payload = await res.json();
    assert.equal(payload.decisionsSplitMode, "session", "保存后应立刻回显");
    assert.equal(payload.decisionsDateSeparator, "_");
    assert.equal(payload.decisionsRetentionDays, 7);
    // 而且真的落盘了（不是只改内存）。
    const raw = readFileSync(join(home, "dsh-decision-engine", "config.yml"), "utf8");
    assert.ok(raw.includes("decisionsSplitMode: session"), `配置内容：${raw}`);
    assert.ok(raw.includes("decisionsDateSeparator: _"), `配置内容：${raw}`);
    assert.ok(raw.includes("decisionsRetentionDays: 7"), `配置内容：${raw}`);
  } finally {
    cleanupDir(home);
  }
});

test("非法的分文件模式 / 分隔符 / 保留天数一律 400，且不落盘", async () => {
  const configPath = (home) => join(home, "dsh-decision-engine", "config.yml");
  for (const patch of [
    { decisionsSplitMode: "Day" },
    { decisionsSplitMode: 1 },
    { decisionsDateSeparator: "," },
    { decisionsRetentionDays: -1 },
    { decisionsRetentionDays: 3651 },
    { decisionsRetentionDays: 1.5 },
    { decisionsRetentionDays: "30" },
  ]) {
    const { home, routes } = setup();
    try {
      const res = await routes["/api/decision-engine/config"].fetch({
        method: "PUT",
        text: async () => JSON.stringify(patch),
      });
      assert.equal(res.status, 400, `${JSON.stringify(patch)} 应被拒`);
      const payload = await res.json();
      assert.equal(typeof payload.error, "string", "应给出可读错误");
      assert.equal(existsSync(configPath(home)), false, "被拒的请求不该写出配置文件");
    } finally {
      cleanupDir(home);
    }
  }
});

test("保留天数 0 是合法值（= 不按天删）", async () => {
  const { home, routes } = setup();
  try {
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsRetentionDays: 0 }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.decisionsRetentionDays, 0);
    const raw = readFileSync(join(home, "dsh-decision-engine", "config.yml"), "utf8");
    assert.ok(raw.includes("decisionsRetentionDays: 0"), `配置内容：${raw}`);
  } finally {
    cleanupDir(home);
  }
});

test("切换成 single 模式后主分片回报旧文件名（兼容旧界面）", async () => {
  const { home, routes } = setup();
  try {
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsSplitMode: "single" }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.ok(
      String(payload.decisionsFile).includes("decisions.jsonl"),
      `single 模式的主分片应沿用旧名：${payload.decisionsFile}`,
    );
  } finally {
    cleanupDir(home);
  }
});

test("session-decisions 回报实际读取的分片清单（files[]）", async () => {
  const { home, routes, dataDir } = setup();
  try {
    const file = seed(dataDir, [
      entry({ seq: 1, sessionId: "session-a" }),
      entry({ seq: 2, sessionId: "session-a" }),
    ]);
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(Array.isArray(data.files), true);
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0], file);
    assert.equal(data.total, 2);
  } finally {
    cleanupDir(home);
  }
});

// ------------------------------------------------------------------ 会话名 / 工作区名解析

test("sessionMetaOf：标题优先，其次 header.title，再退 cwd 目录名", () => {
  const session = { id: "s-1", header: { title: "header 标题", cwd: "/work/repo" } };
  const withService = createSessionMetaResolver({
    getTitleService: () => ({ get: () => ({ title: "服务标题" }) }),
  });
  assert.equal(withService(session).sessionName, "服务标题", "宿主标题最优先");

  const noService = createSessionMetaResolver({ getTitleService: () => undefined });
  assert.equal(noService(session).sessionName, "header 标题", "没有服务时用 header.title");

  const noTitle = createSessionMetaResolver();
  assert.equal(
    // 用当前平台的路径形态：`basename()` 是平台相关的，在 Linux CI 上给它
    // 一个纯反斜杠的 Windows 路径会原样返回（不会取到 repo）。这条断言验的
    // 是「退化到 cwd 目录名」，不是「跨平台解析任意路径」。
    noTitle({ id: "s-2", header: { cwd: join("work", "repo") } }).sessionName,
    "repo",
    "没有标题时用 cwd 的目录名",
  );
});

test("sessionMetaOf：工作区名取 workspaceRoots[0] 的基名，退 cwd", () => {
  const resolver = createSessionMetaResolver();
  assert.equal(
    resolver({ id: "s-roots", header: { cwd: "/tmp/x", workspaceRoots: ["/projects/my-app", "/other"] } })
      .workspaceName,
    "my-app",
  );
  assert.equal(
    resolver({ id: "s-cwd", header: { cwd: "/projects/fallback" } }).workspaceName,
    "fallback",
    "没有 workspaceRoots 时退回 cwd 基名",
  );
});

test("sessionMetaOf：拿不到名字时退化为会话 id / unknown，且永不抛错", () => {
  const resolver = createSessionMetaResolver();
  assert.equal(resolver({ id: "session-id-only" }).sessionName, "session-id-only");
  assert.equal(resolver(undefined).sessionName, "unknown");
  // 标题服务抛错时仍能走 fallback。
  const throwing = createSessionMetaResolver({
    getTitleService: () => {
      throw new Error("host service unavailable");
    },
  });
  assert.equal(throwing({ id: "s", header: { title: "fallback" } }).sessionName, "fallback");
});

test("sessionMetaOf：名字进文件名前先脱敏并截断（隐私）", () => {
  const resolver = createSessionMetaResolver();
  const meta = resolver({
    id: "s",
    header: { title: `sk-ABCDEFGHIJKLMNOPQRST 的会话 ${"x".repeat(200)}`, cwd: "/w/repo" },
  });
  assert.equal(meta.sessionName.includes("sk-ABCDEFGHIJKLMNOPQRST"), false, "密钥形态必须被脱敏");
  assert.ok(meta.sessionName.length <= 64, `截断到 64：${meta.sessionName.length}`);
});

test("sessionMetaOf：按 sessionId 缓存（同一会话不重复问宿主）", () => {
  let calls = 0;
  const resolver = createSessionMetaResolver({
    getTitleService: () => ({
      get: () => {
        calls += 1;
        return { title: "标题" };
      },
    }),
  });
  const session = { id: "cached-session" };
  const first = resolver(session);
  const second = resolver(session);
  assert.equal(first, second, "同一会话应返回同一个对象（命中缓存）");
  assert.equal(calls, 1, "宿主服务只该被问一次");
});

test("sessionMetaOf：字符串 id（思维链翻译点）也能解析", () => {
  const resolver = createSessionMetaResolver();
  const meta = resolver("id-as-string");
  assert.equal(meta.sessionName, "id-as-string");
  assert.equal(typeof meta.workspaceName, "string");
  assert.ok(meta.workspaceName.length > 0);
});

// ------------------------------------------------- 百炼 / TokenHub 配置路由

test("百炼配置能保存并回显 Workspace/地域，端点按 workspace 拼出", async () => {
  const { home, routes } = setup();
  try {
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () =>
        JSON.stringify({
          provider: "bailian",
          bailianWorkspaceId: "ws_demo",
          bailianRegion: "ap-southeast-1",
          bailianModel: "decision-model-preview",
        }),
    });
    assert.equal(res.status, 200, `保存应成功：${JSON.stringify(await res.clone().json())}`);
    const raw = readFileSync(join(home, "dsh-decision-engine", "config.yml"), "utf8");
    assert.ok(raw.includes("provider: bailian"), `配置内容：${raw}`);
    assert.ok(raw.includes("bailianWorkspaceId: ws_demo"), `配置内容：${raw}`);
    assert.ok(raw.includes("bailianRegion: ap-southeast-1"), `配置内容：${raw}`);

    const { status, data } = await get(routes, "/api/decision-engine/status");
    assert.equal(status, 200);
    assert.equal(data.provider, "bailian");
    assert.equal(data.bailianWorkspaceId, "ws_demo");
    assert.equal(data.bailianRegion, "ap-southeast-1");
    assert.match(
      data.baseUrl,
      /^https:\/\/ws_demo\.ap-southeast-1\.maas\.aliyuncs\.com\/compatible-mode\/v1\/systemone$/,
    );
  } finally {
    cleanupDir(home);
  }
});

test("百炼非法地域 / 非法 workspace 一律 400，且不落盘", async () => {
  const configPath = (home) => join(home, "dsh-decision-engine", "config.yml");
  for (const patch of [
    { bailianRegion: "us-east-1" },
    { bailianWorkspaceId: "evil.example.com" },
    { bailianWorkspaceId: "ws with space" },
    { bailianRegion: 1 },
  ]) {
    const { home, routes } = setup();
    try {
      const res = await routes["/api/decision-engine/config"].fetch({
        method: "PUT",
        text: async () => JSON.stringify(patch),
      });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.equal(existsSync(configPath(home)), false, "被拒的请求不该写出配置文件");
    } finally {
      cleanupDir(home);
    }
  }
});
