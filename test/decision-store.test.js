/**
 * 决策明细存储的测试（DEC-022）。
 *
 * 防的是这几类错：
 *
 *   1. **会话归属丢了**——那样「本会话的决策历史」会变成「全机所有会话的
 *      决策」，用户看到一堆不属于自己的记录。
 *   2. **内容没脱敏**——明细里有会话正文与命令片段，一次 `bash` 里贴过的
 *      key 不该躺在磁盘上。
 *   3. **内容没截断**——一条记录能长到几百 KB，文件很快撑爆。
 *   4. **文件无界增长**——必须有体积上限与轮转。
 *   5. **坏行让整页崩掉**——崩溃时写下的半行必须被跳过。
 *   6. **开关关掉后仍然在写**——用户说「不记录」，就必须真的不落盘。
 *
 * 分文件改造（T3）之后还多守几条：
 *
 *   7. **分片落错地方**——记录必须按它自己的 ts 落到对应日期/会话/工作区分片；
 *      跨零点、同名会话、切换模式都不能串。
 *   8. **清理删错东西**——绝不删今天、活跃分片与非 `.log` 文件。
 *   9. **迁移不幂等**——旧文件只能搬一次，且旧文件要保留（`.migrated`）。
 *  10. **紧凑格式不可逆**——读端展开后必须与写盘前同义。
 *
 * 全部走真实的临时目录，不打网络。分文件相关的用例一律把时区钉成 UTC，
 * 让断言与运行机器的本地时区无关。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DecisionStore,
  buildDecisionRecord,
  maskSecrets,
  readTailLines,
  recordIdOf,
  truncateContent,
  DECISIONS_FILE_NAME,
} from "../lib/decision-store.js";
import { dateKeyOf } from "../lib/decision-log.js";

/**
 * 直接往明细文件里写原始记录（模拟**本次修复之前**落盘的老数据）。
 *
 * 老记录没有 `id` 字段，且 `seq` 跨重启重复——这正是真机上的数据形态。
 */
function seedRaw(dir, entries) {
  writeFileSync(
    join(dir, DECISIONS_FILE_NAME),
    entries.map((item) => `${JSON.stringify(item)}\n`).join(""),
    "utf8",
  );
}

/** 造一个隔离的数据目录；返回目录与清理函数。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-decstore-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `logs/` 下某个文件的绝对路径（分文件改造后所有分片都在这里）。 */
function logsPath(dir, name) {
  return join(dir, "logs", name);
}

/** 一条最小记录。 */
function record(over = {}) {
  return buildDecisionRecord({
    sessionId: "session-1",
    point: "authorize",
    tag: "guard",
    mode: "enforce",
    provider: "bamboonode",
    model: "startlux-decision-v1.1-27b-autothink",
    action: "delegate",
    detail: "delegate",
    latencyMs: 1200,
    inputTokens: 2713,
    tool: "bash",
    ...over,
  });
}

// ------------------------------------------------------------------ 记录体

test("记录体带上会话归属与全部关键字段", () => {
  const entry = buildDecisionRecord({
    sessionId: "session-42",
    point: "authorize",
    tag: "guard",
    mode: "observe",
    topMode: "shadow",
    provider: "bamboonode",
    model: "m1",
    action: "delegate",
    detail: "delegate",
    latencyMs: 1689,
    inputTokens: 2713,
    outputTokens: 12,
    tool: "bash",
    turn: 3,
    step: 7,
    scores: { risk_p: 0.9 },
  });
  assert.equal(entry.v, 1);
  assert.equal(entry.sessionId, "session-42");
  assert.equal(entry.point, "authorize");
  assert.equal(entry.mode, "observe");
  assert.equal(entry.topMode, "shadow");
  assert.equal(entry.provider, "bamboonode");
  assert.equal(entry.model, "m1");
  assert.equal(entry.action, "delegate");
  assert.equal(entry.latencyMs, 1689);
  assert.equal(entry.inputTokens, 2713);
  assert.equal(entry.outputTokens, 12);
  assert.equal(entry.tool, "bash");
  assert.equal(entry.turn, 3);
  assert.equal(entry.step, 7);
  assert.deepEqual(entry.scores, { risk_p: 0.9 });
});

test("没有会话 id 时留空串（不可归属），而不是编一个", () => {
  const entry = buildDecisionRecord({ point: "cotTranslate" });
  assert.equal(entry.sessionId, "", "不可归属必须留空，不能臆造");
  assert.equal(entry.point, "cotTranslate");
});

test("缺省的现场字段不硬造 null（不存在的字段就省掉）", () => {
  const entry = buildDecisionRecord({ point: "cotTranslate", sessionId: "s" });
  assert.equal("tool" in entry, false);
  assert.equal("turn" in entry, false);
  assert.equal("step" in entry, false);
  assert.equal("scores" in entry, false);
});

test("记录体可 JSON 化（内容里有循环引用时不抛）", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const entry = buildDecisionRecord({ sessionId: "s", content: { state: cyclic } });
  assert.doesNotThrow(() => JSON.stringify(entry));
});

// ------------------------------------------------------------------ 脱敏

test("脱敏拦掉常见的 key 形态", () => {
  assert.equal(maskSecrets("sk-ABCDEFGHIJKLMNOPQRST"), "sk-***");
  assert.equal(maskSecrets('{"apiKey": "supersecretvalue"}'), '{"apiKey": "***"}');
  assert.match(maskSecrets("Authorization: Bearer abcdefgh12345"), /Bearer \*\*\*/);
  assert.equal(maskSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), "ghp_***");
});

test("脱敏后仍是一行合法 JSON（模式表针对的是 JSON 文本）", () => {
  const line = JSON.stringify({ detail: "用 key sk-ABCDEFGHIJKLMNOPQRST 调用" });
  const masked = maskSecrets(line);
  assert.doesNotThrow(() => JSON.parse(masked));
  assert.equal(JSON.parse(masked).detail.includes("sk-ABCDEFGHIJKLMNOPQRST"), false);
});

test("没有 key 的文本原样通过", () => {
  const text = "just a normal command: ls -la /tmp";
  assert.equal(maskSecrets(text), text);
});

// ------------------------------------------------------------------ 截断

test("内容超限时先砍工具参数，再砍对话摘要", () => {
  const content = {
    state: { args_preview: "x".repeat(3000), recent: "y".repeat(3000) },
    questions: { q: { type: "noul" } },
    answers: { q: { type: "noul", noul: 0.5 } },
  };
  const result = truncateContent(content, 1000);
  assert.equal(result.capture, "full");
  assert.ok(JSON.stringify(result.content).length <= 1000, "裁剪后必须不超过上限");
  assert.ok(result.content.state.args_preview.length < 3000, "参数预览应被砍短");
  assert.deepEqual(result.content.questions, content.questions, "问题集必须保留");
});

test("内容实在太大时退回只留元数据（连问题与回答都装不下）", () => {
  // 只有当**问题与回答本身**就超过上限时才退到 meta —— 参数预览与对话
  // 摘要都是可以砍的，砍完还装不下才说明这次决策本身就有巨大内容。
  const content = {
    state: { args_preview: "x".repeat(100000) },
    questions: { q: { type: "noul", instructions: "y".repeat(100000) } },
    answers: { q: { type: "noul", noul: 0.5 } },
  };
  const result = truncateContent(content, 200);
  assert.equal(result.capture, "meta");
  assert.equal(result.content, null);
});

test("参数预览超长时砍短它，但保住问题与回答（capture 仍是 full）", () => {
  const content = {
    state: { args_preview: "x".repeat(100000) },
    questions: { q: { type: "noul" } },
    answers: { q: { type: "noul", noul: 0.5 } },
  };
  const result = truncateContent(content, 500);
  assert.equal(result.capture, "full");
  assert.ok(JSON.stringify(result.content).length <= 500, "裁剪后必须不超过上限");
  assert.ok(result.content.state.args_preview.length < 100000, "参数预览应被砍短");
  assert.deepEqual(result.content.questions, content.questions, "问题集必须保留");
  assert.deepEqual(result.content.answers, content.answers, "回答必须保留");
});

test("内容在上限内时原样保留", () => {
  const content = { state: { tool: "bash" }, questions: { q: 1 } };
  const result = truncateContent(content, 4000);
  assert.equal(result.capture, "full");
  assert.deepEqual(result.content, content);
});

// ------------------------------------------------------------------ 写入

test("写入后能按会话读回来，且按时间升序", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "s-a", tool: "read" }));
    store.record(record({ sessionId: "s-b", tool: "grep" }));
    store.record(record({ sessionId: "s-a", tool: "bash" }));
    await store.flush();

    const page = await store.readForSession("s-a");
    assert.equal(page.total, 2);
    assert.equal(page.entries.length, 2);
    assert.deepEqual(page.entries.map((entry) => entry.tool), ["read", "bash"]);
  } finally {
    cleanup();
  }
});

test("不存在的会话返回空页，不报错", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    const page = await store.readForSession("never-seen");
    assert.deepEqual(page.entries, []);
    assert.equal(page.total, 0);
  } finally {
    cleanup();
  }
});

test("空会话 id 直接返回空页（不可归属的记录不属于任何人）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "" }));
    await store.flush();
    const page = await store.readForSession("");
    assert.deepEqual(page.entries, []);
  } finally {
    cleanup();
  }
});

test("文件不存在时返回空页，不抛错", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    const page = await store.readForSession("s");
    assert.deepEqual(page.entries, []);
    assert.equal(page.total, 0);
  } finally {
    cleanup();
  }
});

test("坏行被跳过，其余记录照常读出", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "s", tool: "read" }));
    await store.flush();
    // 追加一个「写到一半被杀」的半行。
    appendFileSync(join(dir, DECISIONS_FILE_NAME), '{"v":1,"sessionId":"s","too', "utf8");
    const page = await store.readForSession("s");
    assert.equal(page.total, 1, "坏行不应影响好行");
    assert.equal(page.entries[0].tool, "read");
  } finally {
    cleanup();
  }
});

test("关闭开关后完全不写（不建文件、不占磁盘）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir, getEnabled: () => false });
    const accepted = store.record(record());
    await store.flush();
    assert.equal(accepted, false);
    // 开关关闭时连 `logs/` 目录都不该出现——「不记录」必须真的是不落盘，
    // 而不是「建个空目录然后不写」。
    assert.equal(existsSync(join(dir, "logs")), false, "关闭时不该建目录");
  } finally {
    cleanup();
  }
});

test("开关开启时内容一定落盘（decisionsCapture 不再能静默降级）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // DEC-029：这里曾经能传 `getCapture: () => false`，让元数据照记、内容
    // 被删掉。真机后果是「配置页开关显示开、记录却只有元数据」——用户报的
    // 就是这个。现在构造函数里没有这个选项，开关开着就一定带内容。
    const store = new DecisionStore({ dir });
    store.record(
      buildDecisionRecord({
        sessionId: "s",
        point: "authorize",
        content: { state: { text: "会话正文" }, questions: { q: ["a"] } },
      }),
    );
    await store.flush();
    // 分文件改造后默认写 `logs/<今天>.log`：直接用 store.path 取当前主分片。
    const raw = readFileSync(store.path, "utf8");
    assert.ok(raw.includes("会话正文"), "开关开着时内容必须落盘");
    const page = await store.readForSession("s");
    assert.equal(page.entries[0].capture, "full");
    assert.equal(page.entries[0].content.state.text, "会话正文");
    assert.equal(page.entries[0].contentNote, undefined, "未裁剪时不该有 contentNote");
  } finally {
    cleanup();
  }
});

test("capture:meta 只可能来自超限裁剪，不是任何配置档位", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    // 问题与回答本身就超过上限：连「最后退回元数据」那一档都要走到。
    store.record(
      buildDecisionRecord({
        sessionId: "s",
        point: "authorize",
        maxContentChars: 200,
        content: {
          state: { args_preview: "x".repeat(20000) },
          questions: { q: ["y".repeat(20000)] },
        },
      }),
    );
    await store.flush();
    const page = await store.readForSession("s");
    assert.equal(page.entries[0].capture, "meta", "超限裁剪才产生 meta");
    assert.equal(page.entries[0].content, undefined);
    assert.equal(page.entries[0].contentNote, "too-large");
  } finally {
    cleanup();
  }
});

test("写入的文件权限是 600（明细含会话正文）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record());
    await store.flush();
    // Windows 没有 POSIX 权限位（chmod 只切换只读位，stat 永远报 666），
    // 这条契约在那里无从验证；Linux/macOS 上必须是真的 600。
    if (process.platform !== "win32") {
      const mode = statSync(store.path).mode & 0o777;
      assert.equal(mode, 0o600, `实际权限 ${mode.toString(8)}`);
    } else {
      assert.equal(existsSync(store.path), true, "文件应已写出");
    }
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 轮转

test("超过体积上限时轮转，旧文件只留一代", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 轮转是**单文件模式**的语义；按日期分片时一天一个文件，上限由清理兜底。
    const store = new DecisionStore({ dir, getSplitMode: () => "single", getMaxBytes: () => 1024 });
    for (let index = 0; index < 200; index += 1) {
      store.record(record({ sessionId: "s", tool: `t${index}`, detail: "x".repeat(50) }));
    }
    await store.flush();
    assert.equal(store.rotated > 0, true, "应该至少轮转过一次");
    assert.equal(existsSync(logsPath(dir, "decisions.jsonl.1")), true, "旧文件应留一代");
    const rotated = readFileSync(logsPath(dir, "decisions.jsonl.1"), "utf8");
    assert.ok(rotated.length > 0);
  } finally {
    cleanup();
  }
});

test("轮转后上一代的记录仍能读到（从 .1 里补）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir, getSplitMode: () => "single", getMaxBytes: () => 4096 });
    store.record(record({ sessionId: "old", tool: "first" }));
    await store.flush();
    // 一条一条写并落盘，直到真的轮转过一次为止——这样 .1 里装的就是
    // 「轮转前」的那一批，契约是「上一代还在」。
    for (let index = 0; index < 200 && store.rotated === 0; index += 1) {
      store.record(record({ sessionId: "new", tool: `t${index}`, detail: "y".repeat(200) }));
      await store.flush();
    }
    assert.equal(store.rotated >= 1, true, "应该至少轮转过一次");
    const old = await store.readForSession("old");
    assert.equal(old.total, 1, "上一代的记录不该丢");
    assert.equal(old.entries[0].tool, "first");
  } finally {
    cleanup();
  }
});

test("轮转只留一代：磁盘占用有界（不超过两倍上限）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const limit = 4096;
    const store = new DecisionStore({ dir, getSplitMode: () => "single", getMaxBytes: () => limit });
    for (let index = 0; index < 300; index += 1) {
      store.record(record({ sessionId: "s", tool: `t${index}`, detail: "z".repeat(200) }));
    }
    await store.flush();
    const current = statSync(store.path).size;
    const rotated = existsSync(logsPath(dir, "decisions.jsonl.1"))
      ? statSync(logsPath(dir, "decisions.jsonl.1")).size
      : 0;
    assert.ok(current <= limit, `当前文件 ${current} 应不超过上限 ${limit}`);
    assert.ok(current + rotated <= limit * 2, `总占用 ${current + rotated} 应不超过两倍上限`);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 尾部读

test("尾部读只取最后 N 行，且顺序正确", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "lines.txt");
    writeFileSync(path, ["a", "b", "c", "d", "e"].join("\n"), "utf8");
    const lines = await readTailLines(path, 3);
    assert.deepEqual(lines, ["c", "d", "e"]);
  } finally {
    cleanup();
  }
});

test("尾部读处理没有尾换行的文件", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "lines.txt");
    writeFileSync(path, "a\nb\nc", "utf8");
    const lines = await readTailLines(path, 10);
    assert.deepEqual(lines, ["a", "b", "c"]);
  } finally {
    cleanup();
  }
});

test("尾部读对不存在的文件返回空数组", async () => {
  const lines = await readTailLines("/nonexistent/does/not/exist", 10);
  assert.deepEqual(lines, []);
});

// ------------------------------------------------------------------ 分页

test("limit 会截断结果并标记 truncated", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    for (let index = 0; index < 30; index += 1) {
      store.record(record({ sessionId: "s", tool: `t${index}` }));
    }
    await store.flush();
    const page = await store.readForSession("s", { limit: 10 });
    assert.equal(page.entries.length, 10);
    assert.equal(page.total, 30);
    assert.equal(page.truncated, true);
    // 保留的是**最近**的 10 条（时间升序）。
    assert.equal(page.entries[9].tool, "t29");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 记录身份与顺序
//
// 真机缺陷（2026-11-03）：「点击第二个，展开的是第三个」。
//
// 根因是 `seq` 只在一个进程内唯一：DSH 每重启一次就从 1 重数，于是明细文件里
// 大量记录共用同一批 seq（实测用户数据：307 条只有 119 个不同的 seq）。界面
// 拿它当 React key，重复 key 让事件处理器落到错的行上。
//
// 修复分三处，这里逐个钉住：写入时给全局唯一的 `id`、读取时为老记录补 `id`
// 并保证响应内唯一、**按时间而不是按 seq 排序**。

test("跨重启写入的记录 id 唯一（seq 会重复，id 不会）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 两次独立构造 = 模拟 DSH 重启（进程内计数器各自从 1 开始）。
    const first = new DecisionStore({ dir });
    first.record(record({ sessionId: "s", tool: "run-1-a" }));
    first.record(record({ sessionId: "s", tool: "run-1-b" }));
    await first.flush();

    const second = new DecisionStore({ dir });
    second.record(record({ sessionId: "s", tool: "run-2-a" }));
    second.record(record({ sessionId: "s", tool: "run-2-b" }));
    await second.flush();

    const page = await second.readForSession("s", { limit: 50 });
    const ids = page.entries.map((item) => item.id);
    const seqs = page.entries.map((item) => item.seq);

    assert.equal(page.entries.length, 4);
    assert.equal(new Set(ids).size, 4, `id 必须全局唯一，实际：${JSON.stringify(ids)}`);
    assert.ok(new Set(seqs).size < 4, `前置：seq 本该重复，实际：${JSON.stringify(seqs)}`);

    // 关键补充：**落盘的文件里** id 就必须唯一，而不是靠读取层的去重后缀兜住。
    //
    // 读端的确还有一道「撞了就加位置后缀」的保险，所以只断言「返回的 id 唯一」
    // 是不足以钉住写入侧的——变异测试证明了这一点：把写入的 id 退回 `String(seq)`
    // 之后，读端照样能返回唯一 id，那条断言不会红。
    // 但靠去重后缀是**下策**：它产生的是位置相关的合成 id，窗口一变就可能漂移。
    // 真正的修法是写入时就唯一（进程前缀 + seq），这里直接检查磁盘。
    const raw = readFileSync(second.path, "utf8");
    const storedIds = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line).id);
    assert.equal(storedIds.length, 4);
    assert.equal(
      new Set(storedIds).size,
      4,
      `落盘记录的 id 必须唯一，实际：${JSON.stringify(storedIds)}`,
    );
  } finally {
    cleanup();
  }
});

test("没有 id 的老记录在读取时被补上唯一 id", async () => {
  const { dir, cleanup } = tempDir();
  try {
    seedRaw(dir, [
      { v: 1, seq: 1, ts: "2026-11-03T08:00:00.000Z", sessionId: "s", point: "authorize" },
      { v: 1, seq: 1, ts: "2026-11-03T08:01:00.000Z", sessionId: "s", point: "authorize" },
      { v: 1, seq: 2, ts: "2026-11-03T08:02:00.000Z", sessionId: "s", point: "authorize" },
    ]);
    const store = new DecisionStore({ dir });
    const page = await store.readForSession("s", { limit: 50 });
    const ids = page.entries.map((item) => item.id);
    assert.equal(page.entries.length, 3);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0), `都应补上 id：${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, 3, `补出来的 id 也必须唯一：${JSON.stringify(ids)}`);
  } finally {
    cleanup();
  }
});

test("按时间排序，而不是按 seq（seq 每重启一次就重数）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 交错写入两批：seq 会重复，但 ts 单调递增。
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "s", ts: "2026-11-03T08:00:00.000Z", tool: "a1" }));
    store.record(record({ sessionId: "s", ts: "2026-11-03T08:01:00.000Z", tool: "a2" }));
    await store.flush();
    const second = new DecisionStore({ dir });
    second.record(record({ sessionId: "s", ts: "2026-11-03T08:02:00.000Z", tool: "b1" }));
    second.record(record({ sessionId: "s", ts: "2026-11-03T08:03:00.000Z", tool: "b2" }));
    await second.flush();
    // 把第二批的 seq 造得比第一批小，模拟「重启后从 1 重数」的真实形态。
    // （真实文件里就是 append 顺序 = 时间顺序，这里直接验证读回来的顺序。）

    const page = await second.readForSession("s", { limit: 50 });
    const times = page.entries.map((item) => item.ts);
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted, `读回来必须按时间升序，实际：${JSON.stringify(times)}`);
  } finally {
    cleanup();
  }
});

test("recordIdOf：优先用 id，老记录退回 ts#seq", () => {
  assert.equal(recordIdOf({ id: "abc-1", ts: "t", seq: 1 }), "abc-1");
  assert.equal(recordIdOf({ ts: "t", seq: 7 }), "t#7");
  assert.equal(recordIdOf({ seq: 7 }), "#7");
  assert.equal(recordIdOf(null), "");
  assert.equal(recordIdOf({}), "");
});

// ------------------------------------------------------------------ 分文件（T3）
//
// 这一组全部把时区钉成 UTC：分片名与「今天」都依赖时区，钉死之后
// 断言与运行机器的本地时区无关（否则在 CI 的不同时区里会随机红）。

/** 固定 UTC 时区 + 指定模式的 store。 */
function utcStore(dir, options = {}) {
  return new DecisionStore({ dir, getTimeZone: () => "UTC", ...options });
}

test("date 模式：按记录 ts 落到 YYYY-MM-DD.log", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "date" });
    store.record(record({ sessionId: "s", ts: "2026-11-03T08:00:00.000Z", tool: "a" }));
    await store.flush();
    assert.equal(existsSync(logsPath(dir, "2026-11-03.log")), true, "应按记录日期命名");
    const page = await store.readForSession("s");
    assert.equal(page.total, 1);
    assert.equal(page.files.length, 1);
    assert.ok(page.files[0].endsWith("2026-11-03.log"), `实际：${page.files[0]}`);
  } finally {
    cleanup();
  }
});

test("date 模式：跨两天写入分成两个文件，读回来仍按时间合并", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "date" });
    store.record(record({ sessionId: "s", ts: "2026-11-03T23:00:00.000Z", tool: "day1" }));
    store.record(record({ sessionId: "s", ts: "2026-11-04T00:30:00.000Z", tool: "day2" }));
    await store.flush();
    assert.equal(existsSync(logsPath(dir, "2026-11-03.log")), true);
    assert.equal(existsSync(logsPath(dir, "2026-11-04.log")), true);
    const page = await store.readForSession("s");
    assert.deepEqual(page.entries.map((entry) => entry.tool), ["day1", "day2"]);
    assert.equal(page.files.length, 2, "两个分片都应被读到");
  } finally {
    cleanup();
  }
});

test("date 模式：日期分隔符可配置（_ / .）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const underscore = utcStore(dir, { getSplitMode: () => "date", getDateSeparator: () => "_" });
    underscore.record(record({ sessionId: "s", ts: "2026-11-03T08:00:00.000Z" }));
    await underscore.flush();
    assert.equal(existsSync(logsPath(dir, "2026_11_03.log")), true);

    const dot = utcStore(dir, { getSplitMode: () => "date", getDateSeparator: () => "." });
    dot.record(record({ sessionId: "s", ts: "2026-11-05T08:00:00.000Z" }));
    await dot.flush();
    assert.equal(existsSync(logsPath(dir, "2026.11.05.log")), true);
  } finally {
    cleanup();
  }
});

test("date 模式：旧日期分片按从新到旧读取，受 scanLines 配额约束", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "date" });
    // 直接写两个「最近两天」的分片：today 与 today-1。用真实日期算，
    // 这样「今天的分片」与读取路径的判定一致（不依赖测试运行的具体日期）。
    const todayKey = dateKeyOf(Date.now(), "UTC");
    const yesterdayKey = dateKeyOf(Date.now() - 24 * 60 * 60 * 1000, "UTC");
    mkdirSync(join(dir, "logs"), { recursive: true });
    const entry = (tool) => `${JSON.stringify({ v: 1, seq: 1, ts: `${todayKey}T00:00:00.000Z`, sessionId: "s", point: "authorize", tool })}\n`;
    writeFileSync(logsPath(dir, `${yesterdayKey}.log`), entry("yesterday"), "utf8");
    writeFileSync(logsPath(dir, `${todayKey}.log`), entry("today"), "utf8");

    const page = await store.readForSession("s", { scanLines: 1, limit: 1 });
    assert.equal(page.scanned, 1, `只该扫 1 行，实际 ${page.scanned}`);
    assert.equal(page.files.length, 1, "配额用完就不再读更旧的分片");
    assert.deepEqual(page.entries.map((item) => item.tool), ["today"], "先读最新的分片");
    assert.equal(page.truncated, true, "命中扫描上限应标记 truncated");
  } finally {
    cleanup();
  }
});

test("session 模式：同名会话不同 id 不串文件", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "session" });
    store.record(record({ sessionId: "aaaaaaaa-1111", tool: "from-a" }), { sessionName: "同一个名字" });
    store.record(record({ sessionId: "bbbbbbbb-2222", tool: "from-b" }), { sessionName: "同一个名字" });
    await store.flush();
    const names = readdirSync(join(dir, "logs")).filter((name) => name.endsWith(".log")).sort();
    assert.equal(names.length, 2, `应写两个文件，实际：${names}`);
    assert.ok(names[0].includes("__aaaaaaaa"), `文件名应带 id 前 8 位：${names[0]}`);
    assert.ok(names[1].includes("__bbbbbbbb"), `文件名应带 id 前 8 位：${names[1]}`);
    // 关键：读 A 只拿到 A 的记录。
    const page = await store.readForSession("aaaaaaaa-1111");
    assert.deepEqual(page.entries.map((entry) => entry.tool), ["from-a"]);
    const other = await store.readForSession("bbbbbbbb-2222");
    assert.deepEqual(other.entries.map((entry) => entry.tool), ["from-b"]);
  } finally {
    cleanup();
  }
});

test("session 模式：没有会话名时退化为会话 id", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "session" });
    store.record(record({ sessionId: "cccccccc-3333", tool: "only" }));
    await store.flush();
    const names = readdirSync(join(dir, "logs"));
    assert.equal(names.length, 1);
    assert.ok(names[0].includes("cccccccc"), `文件名应含 id：${names[0]}`);
    assert.ok(names[0].endsWith("__cccccccc.log"), `实际：${names[0]}`);
    assert.equal((await store.readForSession("cccccccc-3333")).total, 1);
  } finally {
    cleanup();
  }
});

test("workspace 模式：按工作区名分文件，读取时读全部分片", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "workspace" });
    store.record(record({ sessionId: "s", tool: "a" }), { workspaceName: "my-project" });
    store.record(record({ sessionId: "s2", tool: "b" }), { workspaceName: "other/项目" });
    await store.flush();
    assert.equal(existsSync(logsPath(dir, "my-project.log")), true);
    const names = readdirSync(join(dir, "logs"));
    assert.equal(names.length, 2, `实际：${names}`);
    // 斜杠会被清洗掉（文件名里不能有路径分隔符），发生清洗时带短哈希防撞。
    assert.ok(
      names.some((name) => name.startsWith("other_项目~")),
      `工作区名里的 / 应被清洗并加哈希：${names}`,
    );
    const page = await store.readForSession("s");
    assert.equal(page.total, 1, "workspace 模式读全部文件，但仍按会话过滤");
    assert.equal(page.files.length, 2, "两个分片都应被读到");
  } finally {
    cleanup();
  }
});

test("path getter 返回当前主分片（没写过时按此刻算）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "date" });
    const expected = logsPath(dir, `${dateKeyOf(Date.now(), "UTC")}.log`);
    assert.equal(store.path, expected);
    store.record(record({ sessionId: "s", ts: "2026-11-03T08:00:00.000Z" }));
    await store.flush();
    assert.equal(store.path, logsPath(dir, "2026-11-03.log"), "写过后应指向实际写入的分片");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 紧凑格式（写入侧）

test("写入磁盘时应用紧凑格式，读回来仍是完整形状", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "date" });
    const shared = { status: "completed", primary: { status: "completed" }, fallback: null };
    store.record(
      record({
        sessionId: "s",
        ts: "2026-11-03T08:00:00.000Z",
        scores: { modelEvaluation: shared },
        content: {
          state: { tool: "bash", modelEvaluation: shared },
          answers: { modelEvaluation: shared },
          questions: { q: { type: "noul" } },
        },
      }),
    );
    await store.flush();
    const raw = readFileSync(logsPath(dir, "2026-11-03.log"), "utf8");
    const stored = JSON.parse(raw.trim());
    // 磁盘上只该有一份 modelEvaluation（在 scores 里），另外两处被折叠。
    assert.deepEqual(stored.scores.modelEvaluation, shared);
    assert.equal(stored.content.state.modelEvaluation, undefined);
    assert.equal(stored.content.answers.modelEvaluation, undefined);
    assert.deepEqual(stored.dedup, ["state.modelEvaluation", "answers.modelEvaluation"]);
    const page = await store.readForSession("s");
    const entry = page.entries[0];
    assert.deepEqual(entry.content.state.modelEvaluation, shared);
    assert.deepEqual(entry.content.answers.modelEvaluation, shared);
    assert.equal(entry.dedup, undefined, "展开后不该残留折叠标记");
    // 默认空值也省掉了（磁盘上没有 topMode），展开后补回。
    assert.equal(stored.topMode, undefined, "空串默认值不该落盘");
    assert.equal(entry.topMode, "");
    assert.equal(entry.latencyMs, 1200, "非默认数值必须原样保留");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 清理

test("cleanupOnce 删过期的、保留今天与活跃分片，且不碰非 .log", async () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(join(dir, "logs"), { recursive: true });
    const todayKey = dateKeyOf(Date.now(), "UTC");
    // 过期（保留 30 天，2020 年的必删）。
    writeFileSync(logsPath(dir, "2020-01-01.log"), "old\n", "utf8");
    // 今天的分片：绝不删。
    writeFileSync(logsPath(dir, `${todayKey}.log`), "today\n", "utf8");
    // 非 .log：绝不删（迁移备份 / 标记 / 单文件模式的 jsonl 都不归清理管）。
    writeFileSync(logsPath(dir, "decisions.jsonl.migrated"), "keep\n", "utf8");
    writeFileSync(logsPath(dir, "notes.txt"), "keep\n", "utf8");
    const store = utcStore(dir, { getSplitMode: () => "date", getRetentionDays: () => 30 });
    const report = await store.cleanupOnce();
    assert.equal(report.removed, 1, `应只删 1 个过期分片，实际 ${report.removed}`);
    assert.equal(existsSync(logsPath(dir, "2020-01-01.log")), false);
    assert.equal(existsSync(logsPath(dir, `${todayKey}.log`)), true, "今天的分片不能删");
    assert.equal(existsSync(logsPath(dir, "decisions.jsonl.migrated")), true);
    assert.equal(existsSync(logsPath(dir, "notes.txt")), true);
    assert.equal(report.files, 1);
    // 报告要被 storageReport() 记住（设置页的显示来源）。
    assert.equal(store.storageReport().removed, 1);
  } finally {
    cleanup();
  }
});

test("cleanupOnce 不删当前活跃分片（哪怕它已过期）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getSplitMode: () => "date", getRetentionDays: () => 30 });
    // 用一条很旧的 ts 写一个分片：它既是「过期」，又是「本进程写过」的活跃分片。
    store.record(record({ sessionId: "s", ts: "2020-01-01T08:00:00.000Z" }));
    await store.flush();
    assert.equal(existsSync(logsPath(dir, "2020-01-01.log")), true);
    const report = await store.cleanupOnce();
    assert.equal(report.removed, 0, "活跃分片不能删");
    assert.equal(existsSync(logsPath(dir, "2020-01-01.log")), true);
  } finally {
    cleanup();
  }
});

test("cleanupOnce 按总量上限从最旧开始删，仍不碰今天", async () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(join(dir, "logs"), { recursive: true });
    const todayKey = dateKeyOf(Date.now(), "UTC");
    const old = logsPath(dir, "2020-01-01.log");
    writeFileSync(old, "x".repeat(2048), "utf8");
    // mtime 拉开，确保「最旧」的顺序确定。
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    writeFileSync(logsPath(dir, `${todayKey}.log`), "y".repeat(2048), "utf8");
    const store = utcStore(dir, {
      getSplitMode: () => "date",
      getRetentionDays: () => 0,
      getTotalMaxBytes: () => 1024,
    });
    const report = await store.cleanupOnce();
    assert.equal(report.removed, 1, `应删最旧的 1 个，实际 ${report.removed}`);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(logsPath(dir, `${todayKey}.log`)), true, "今天的分片不能删");
    assert.ok(report.bytes <= 2048, "删完后总量应受上限约束（今天那个不能再删）");
  } finally {
    cleanup();
  }
});

test("开关关闭时 cleanupOnce 不动磁盘", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir, { getEnabled: () => false, getRetentionDays: () => 30 });
    const report = await store.cleanupOnce();
    assert.equal(report.removed, 0);
    assert.equal(existsSync(join(dir, "logs")), false, "关着的时候连目录都不该建");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 迁移

test("迁移：旧 decisions.jsonl 落到日期分片、旧文件改名保留、二次调用无副作用", async () => {
  const { dir, cleanup } = tempDir();
  try {
    seedRaw(dir, [
      { v: 1, seq: 1, ts: "2026-11-03T08:00:00.000Z", sessionId: "s", point: "authorize", action: "allow" },
      { v: 1, seq: 2, ts: "2026-11-04T08:00:00.000Z", sessionId: "s", point: "authorize", action: "deny" },
    ]);
    // `.1` 是更早的一代，也应一并迁移。
    writeFileSync(
      join(dir, "decisions.jsonl.1"),
      `${JSON.stringify({ v: 1, seq: 9, ts: "2026-11-01T08:00:00.000Z", sessionId: "s", point: "authorize" })}\n`,
      "utf8",
    );
    const store = utcStore(dir, { getSplitMode: () => "date" });
    const migrated = await store.migrateLegacyOnce();
    assert.equal(migrated, 3, `应迁移 3 条，实际 ${migrated}`);
    assert.equal(existsSync(logsPath(dir, "2026-11-03.log")), true);
    assert.equal(existsSync(logsPath(dir, "2026-11-04.log")), true);
    assert.equal(existsSync(logsPath(dir, "2026-11-01.log")), true);
    // 旧文件保留（改名），不删。
    assert.equal(existsSync(join(dir, "decisions.jsonl")), false);
    assert.equal(existsSync(join(dir, "decisions.jsonl.migrated")), true);
    assert.equal(existsSync(join(dir, "decisions.jsonl.1.migrated")), true);
    // 标记存在 → 第二次调用不再有任何副作用。
    assert.equal(existsSync(join(dir, "decisions-log-migrated")), true);
    const before = readdirSync(join(dir, "logs")).sort();
    const second = await store.migrateLegacyOnce();
    assert.equal(second, 0);
    assert.deepEqual(readdirSync(join(dir, "logs")).sort(), before, "二次调用不该再写文件");
    // 迁移后的记录能按会话读回来（读取路径会 expand）。
    const page = await store.readForSession("s");
    assert.equal(page.total, 3);
  } finally {
    cleanup();
  }
});

test("迁移：logs 已存在时跳过（不搬旧文件，只写标记）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(logsPath(dir, "2026-11-03.log"), "already-new\n", "utf8");
    seedRaw(dir, [
      { v: 1, seq: 1, ts: "2026-11-04T08:00:00.000Z", sessionId: "s", point: "authorize" },
    ]);
    const store = utcStore(dir, { getSplitMode: () => "date" });
    assert.equal(await store.migrateLegacyOnce(), 0);
    assert.equal(existsSync(join(dir, "decisions.jsonl")), true, "不该动旧文件");
    assert.equal(existsSync(join(dir, "decisions-log-migrated")), true);
    assert.equal(await store.migrateLegacyOnce(), 0);
  } finally {
    cleanup();
  }
});

test("迁移：空 logs 目录（上次迁移中途失败）仍会继续迁移", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 模拟「mkdir 成功、写分片失败」留下的现场：目录在、分片没有、旧文件还在。
    mkdirSync(join(dir, "logs"), { recursive: true });
    seedRaw(dir, [
      { v: 1, seq: 1, ts: "2026-11-04T08:00:00.000Z", sessionId: "s", point: "authorize" },
    ]);
    const store = utcStore(dir, { getSplitMode: () => "date" });
    assert.equal(await store.migrateLegacyOnce(), 1, "空目录不该永久关死迁移");
    assert.equal(existsSync(logsPath(dir, "2026-11-04.log")), true);
    assert.equal(existsSync(join(dir, "decisions.jsonl.migrated")), true);
  } finally {
    cleanup();
  }
});

test("迁移：没有旧文件时只写标记（下次启动不再扫）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = utcStore(dir);
    assert.equal(await store.migrateLegacyOnce(), 0);
    assert.equal(existsSync(join(dir, "decisions-log-migrated")), true);
    assert.equal(existsSync(join(dir, "logs")), false, "没有旧数据就不该建日志目录");
  } finally {
    cleanup();
  }
});

test("切换分文件模式后，旧命名分片里的历史仍读得到（不丢历史）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 先用 date 模式写一条。
    const dates = utcStore(dir, { getSplitMode: () => "date" });
    dates.record(record({ sessionId: "s-switch", ts: "2026-11-03T08:00:00.000Z", tool: "old" }));
    await dates.flush();
    // 切成 session 模式：该会话没有 `__id8` 分片、也没有单一文件/旧格式，
    // 读取必须退到「全部分片」兜底，否则用户切一次模式就以为历史被删了。
    const sessions = utcStore(dir, { getSplitMode: () => "session" });
    const page = await sessions.readForSession("s-switch");
    assert.equal(page.total, 1, "切换模式不该丢历史");
    assert.equal(page.entries[0].tool, "old");
    assert.ok(page.files[0].endsWith("2026-11-03.log"));
  } finally {
    cleanup();
  }
});

test("single 模式也能读到迁移后的日期分片（升级 + 选单一文件不丢历史）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const dates = utcStore(dir, { getSplitMode: () => "date" });
    dates.record(record({ sessionId: "s-single", ts: "2026-11-03T08:00:00.000Z", tool: "old" }));
    await dates.flush();
    const single = utcStore(dir, { getSplitMode: () => "single" });
    const page = await single.readForSession("s-single");
    assert.equal(page.total, 1);
    assert.equal(page.entries[0].tool, "old");
  } finally {
    cleanup();
  }
});
