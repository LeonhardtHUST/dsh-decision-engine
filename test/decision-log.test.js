/**
 * 决策日志**纯函数层**的测试（lib/decision-log.js，T3）。
 *
 * 这一层是分文件 / 紧凑格式的全部「算名字、算日期、压缩记录」逻辑，零 I/O，
 * 所以这里的断言可以一条一条钉死边界：
 *
 *   1. **时区**：日期键必须按配置时区取，不能用 UTC——东八区凌晨的记录
 *      会被算到前一天（真机上就是「今天的日志里没有今天的记录」）。
 *   2. **文件名**：会话名/工作区名是用户内容，必须剔除路径分隔符与控制字符、
 *      避开 Windows 保留名；名字被改动或截断时要带短哈希，防止两个不同的
 *      名字落进同一个文件（那会让两个会话的日志串在一起）。
 *   3. **紧凑格式**：删掉的每个字段都必须能还原——读端 `expandRecord()`
 *      之后记录形状与写盘前完全一致。
 *
 * 全部不碰磁盘、不打网络。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DATE_SEPARATORS,
  DEFAULT_DATE_SEPARATOR,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SPLIT_MODE,
  SESSION_ID_SEGMENT_LENGTH,
  SPLIT_MODES,
  compactRecord,
  dateKeyOf,
  expandRecord,
  normalizeDateSeparator,
  normalizeSplitMode,
  parseShardDate,
  rotatedNameOf,
  sanitizeSegment,
  shardFileName,
  systemTimeZone,
} from "../lib/decision-log.js";
import { guardQuestions, GUARD_QUESTIONS_VERSION } from "../lib/guard/advisory.js";

// ------------------------------------------------------------------ 常量

test("模式与分隔符的默认值、合法集合", () => {
  assert.deepEqual(SPLIT_MODES, ["single", "date", "session", "workspace"]);
  assert.equal(DEFAULT_SPLIT_MODE, "date", "默认按日期分文件");
  assert.deepEqual(DATE_SEPARATORS, ["-", "_", "."]);
  assert.equal(DEFAULT_DATE_SEPARATOR, "-");
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.equal(SESSION_ID_SEGMENT_LENGTH, 8);
});

test("无法识别的模式/分隔符退回默认档（不抛错）", () => {
  assert.equal(normalizeSplitMode("Day"), DEFAULT_SPLIT_MODE);
  assert.equal(normalizeSplitMode(undefined), DEFAULT_SPLIT_MODE);
  assert.equal(normalizeSplitMode("session"), "session");
  assert.equal(normalizeDateSeparator(","), DEFAULT_DATE_SEPARATOR);
  assert.equal(normalizeDateSeparator("_"), "_");
});

// ------------------------------------------------------------------ 日期键

test("dateKeyOf：东八区凌晨与 UTC 差一天（不能用 toISOString().slice）", () => {
  // 2026-11-16 00:30（Asia/Shanghai）= 2026-11-15T16:30Z
  assert.equal(dateKeyOf("2026-11-15T16:30:00.000Z", "Asia/Shanghai"), "2026-11-16");
  assert.equal(dateKeyOf("2026-11-15T16:30:00.000Z", "UTC"), "2026-11-15");
  // 跨年同理：2026-01-01 00:00 +08:00 = 2025-12-31T16:00Z
  assert.equal(dateKeyOf("2025-12-31T16:00:00.000Z", "Asia/Shanghai"), "2026-01-01");
  assert.equal(dateKeyOf("2025-12-31T16:00:00.000Z", "UTC"), "2025-12-31");
});

test("dateKeyOf：接受 Date 与毫秒数，非法时间退回此刻", () => {
  const date = new Date("2026-11-15T16:30:00.000Z");
  assert.equal(dateKeyOf(date, "Asia/Shanghai"), "2026-11-16");
  assert.equal(dateKeyOf(date.getTime(), "Asia/Shanghai"), "2026-11-16");
  const fallback = dateKeyOf("not-a-date", "UTC");
  assert.match(fallback, /^\d{4}-\d{2}-\d{2}$/, "坏时间也必须给出一个合法日期键");
  assert.notEqual(dateKeyOf(undefined, "UTC").length, 0);
});

test("dateKeyOf：时区名写错时退回系统时区，不抛错", () => {
  const key = dateKeyOf("2026-11-15T16:30:00.000Z", "Not/AZone");
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

test("systemTimeZone 返回非空字符串", () => {
  assert.equal(typeof systemTimeZone(), "string");
  assert.ok(systemTimeZone().length > 0);
});

// ------------------------------------------------------------------ 文件名清洗

test("sanitizeSegment：干净的名字原样保留（人类可读优先）", () => {
  assert.equal(sanitizeSegment("My Session"), "My Session");
  assert.equal(sanitizeSegment("repo-2026"), "repo-2026");
  assert.equal(sanitizeSegment("中文会话名"), "中文会话名");
});

test("sanitizeSegment：非法字符替换为下划线，并追加短哈希防撞", () => {
  const dirty = 'a<b>c:d"e/f\\g|h?i*j';
  const clean = sanitizeSegment(dirty);
  assert.equal(/[<>:"/\\|?*]/.test(clean), false, `非法字符必须清掉：${clean}`);
  assert.match(clean, /^[^~]+~[0-9a-f]{6}$/, `改动过的名字要带哈希：${clean}`);
  // 两个不同的非法名字不能洗成同一个文件名。
  assert.notEqual(sanitizeSegment("a:b"), sanitizeSegment("a?b"));
});

test("sanitizeSegment：C0 / C1 控制字符被替换", () => {
  const clean = sanitizeSegment("a\u0000b\u001fc\u007fd\u009fe");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(clean), false, `控制字符必须清掉：${clean}`);
  assert.ok(clean.startsWith("a_b_c_d_e"), `实际：${clean}`);
});

test("sanitizeSegment：Windows 保留设备名加前缀下划线（含带扩展名）", () => {
  for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"]) {
    const clean = sanitizeSegment(name);
    assert.ok(clean.startsWith(`_${name}`), `${name} 应加前缀：${clean}`);
  }
  assert.ok(sanitizeSegment("con.txt").startsWith("_con.txt"), "带扩展名的保留名也要避开");
  // 不是保留名的相似名字不受影响。
  assert.equal(sanitizeSegment("CONSOLE"), "CONSOLE");
  assert.equal(sanitizeSegment("COM10"), "COM10");
});

test("sanitizeSegment：去首尾点与空格、折叠连续字符", () => {
  assert.ok(sanitizeSegment("name. ").startsWith("name"), "结尾的点与空格要去掉");
  assert.ok(sanitizeSegment("..hidden").startsWith("hidden"), "开头的点要去掉");
  assert.ok(sanitizeSegment("a   b").startsWith("a b"), "连续空白折叠成一个");
  assert.ok(sanitizeSegment("a___b").startsWith("a_b"), "连续下划线折叠成一个");
  assert.equal(sanitizeSegment(" . "), "unknown", "全是点与空格的等于空");
});

test("sanitizeSegment：按码点截断并带哈希（不劈开代理对）", () => {
  const long = "x".repeat(80);
  const clean = sanitizeSegment(long);
  const [base, hash] = clean.split("~");
  assert.equal(Array.from(base).length, 48, "默认截断到 48 个码点");
  assert.equal(hash.length, 6);
  assert.notEqual(sanitizeSegment(`${long}a`), clean, "共享前缀的两个长名字不能撞");

  const emoji = "😀".repeat(60);
  const truncated = sanitizeSegment(emoji);
  const [emojiBase] = truncated.split("~");
  assert.equal(Array.from(emojiBase).length, 48, "按码点截断，不能按 UTF-16 代码单元");
  // 不能留下半个代理对：逐码点还原后应与原串前 48 个 emoji 完全一致。
  assert.equal(emojiBase, "😀".repeat(48), "截断不能劈开代理对");
});

test("sanitizeSegment：maxLength 可配置", () => {
  const clean = sanitizeSegment("abcdefghij", { maxLength: 5 });
  assert.ok(clean.startsWith("abcde~"), `实际：${clean}`);
  assert.equal(Array.from(clean.split("~")[0]).length, 5);
});

test("sanitizeSegment：空/非字符串 → unknown", () => {
  assert.equal(sanitizeSegment(""), "unknown");
  assert.equal(sanitizeSegment("   "), "unknown");
  assert.equal(sanitizeSegment(undefined), "unknown");
  assert.equal(sanitizeSegment(null), "unknown");
  assert.equal(sanitizeSegment(42), "42");
});

test("sanitizeSegment：NFKC 归一（全角字母折叠成半角）", () => {
  const clean = sanitizeSegment("ＡＢＣ");
  assert.ok(clean.startsWith("ABC"), `全角应被归一：${clean}`);
});

// ------------------------------------------------------------------ 分片命名

test("shardFileName：single 模式沿用旧文件名", () => {
  assert.equal(shardFileName({ splitMode: "single" }), "decisions.jsonl");
});

test("shardFileName：date 模式与三种分隔符", () => {
  const ts = "2026-11-03T08:00:00.000Z";
  assert.equal(shardFileName({ splitMode: "date", ts, timeZone: "UTC" }), "2026-11-03.log");
  assert.equal(shardFileName({ splitMode: "date", ts, timeZone: "UTC", separator: "_" }), "2026_11_03.log");
  assert.equal(shardFileName({ splitMode: "date", ts, timeZone: "UTC", separator: "." }), "2026.11.03.log");
});

test("shardFileName：session 模式带会话名与 id 前 8 位", () => {
  const name = shardFileName({
    splitMode: "session",
    sessionId: "12345678-abcd-ef00-0000-000000000000",
    sessionName: "重构存储",
  });
  assert.equal(name, "重构存储__12345678.log");
  // 没有名字时退化为 id（完整 id 当可读段，id 前 8 位当防撞后缀）。
  assert.equal(
    shardFileName({ splitMode: "session", sessionId: "abcdefgh-1111" }),
    "abcdefgh-1111__abcdefgh.log",
  );
  // 名字里的非法字符会被清洗。
  const dirty = shardFileName({ splitMode: "session", sessionId: "id-0000001", sessionName: "a/b" });
  assert.equal(dirty.includes("/"), false);
  assert.match(dirty, /__id-00000\.log$/, `实际：${dirty}`);
});

test("shardFileName：workspace 模式用工作区名，缺失退化为 unknown", () => {
  assert.equal(shardFileName({ splitMode: "workspace", workspaceName: "my-project" }), "my-project.log");
  assert.equal(shardFileName({ splitMode: "workspace" }), "unknown.log");
});

test("rotatedNameOf：两种命名都只留一代", () => {
  assert.equal(rotatedNameOf("2026-11-15.log"), "2026-11-15.1.log");
  assert.equal(rotatedNameOf("decisions.jsonl"), "decisions.jsonl.1");
  assert.equal(rotatedNameOf("my__abcd1234.log"), "my__abcd1234.1.log");
});

// ------------------------------------------------------------------ 分片日期解析

test("parseShardDate：三种分隔符与轮转后缀", () => {
  assert.deepEqual(parseShardDate("2026-11-15.log"), {
    year: 2026, month: 11, day: 15, key: "2026-11-15", rotation: 0,
  });
  assert.equal(parseShardDate("2026-11-15.1.log").rotation, 1);
  assert.equal(parseShardDate("2026_11_15.log").key, "2026-11-15");
  assert.equal(parseShardDate("2026.11.15.log").key, "2026-11-15");
  // 带目录的路径也认。
  assert.equal(parseShardDate("C:/data/logs/2026-11-15.log").key, "2026-11-15");
});

test("parseShardDate：非日期分片与非法日期都返回 null", () => {
  assert.equal(parseShardDate("my-project.log"), null);
  assert.equal(parseShardDate("decisions.jsonl"), null);
  assert.equal(parseShardDate("2026-13-01.log"), null, "13 月不存在");
  assert.equal(parseShardDate("2026-02-30.log"), null, "2 月没有 30 日");
  assert.equal(parseShardDate("2026-11-15.txt"), null);
  assert.equal(parseShardDate(""), null);
  assert.equal(parseShardDate(undefined), null);
});

// ------------------------------------------------------------------ 紧凑 / 展开

/** 一条「字段齐整」的记录（形状与 buildDecisionRecord 的输出对齐）。 */
function richRecord(over = {}) {
  const shared = { status: "completed", primary: { status: "completed" }, fallback: null };
  return {
    v: 1,
    seq: 3,
    id: "abcd1234-3",
    ts: "2026-11-03T08:00:00.000Z",
    sessionId: "s-1",
    point: "authorize",
    tag: "guard",
    mode: "enforce",
    topMode: "enforce",
    provider: "bamboonode",
    model: "m-1",
    action: "delegate",
    detail: "delegate",
    latencyMs: 1200,
    inputTokens: 2713,
    outputTokens: 12,
    cached: false,
    degraded: false,
    capture: "full",
    scores: { modelEvaluation: shared, risk_p: 0.1 },
    content: {
      state: { tool: "bash", modelEvaluation: shared },
      answers: { modelEvaluation: shared },
      questions: guardQuestions(),
    },
    ...over,
  };
}

test("compactRecord / expandRecord：完整往返（语义逐字段一致）", () => {
  const record = richRecord();
  const expanded = expandRecord(compactRecord(record));
  // 深比较而不是逐字节：还原的 modelEvaluation 会追加在对象末尾（顺序不同、
  // 语义相同），读取路径上不许依赖字节序。
  assert.deepEqual(expanded, record, "展开后必须与写盘前同义");
});

test("compactRecord：与 scores 逐字节相同的 modelEvaluation 才折叠", () => {
  const shared = { status: "completed" };
  const same = compactRecord({
    ...richRecord(),
    scores: { modelEvaluation: shared },
    content: { state: { modelEvaluation: shared }, answers: { modelEvaluation: shared }, questions: {} },
  });
  assert.deepEqual(same.dedup, ["state.modelEvaluation", "answers.modelEvaluation"]);
  assert.equal(same.content.state.modelEvaluation, undefined);

  // 内容不同（哪怕只差一个字段）就不能删——那可能是另一次现场。
  const different = compactRecord({
    ...richRecord(),
    scores: { modelEvaluation: { status: "completed" } },
    content: {
      state: { modelEvaluation: { status: "failed" } },
      answers: { modelEvaluation: { status: "completed" } },
      questions: {},
    },
  });
  assert.deepEqual(different.dedup, ["answers.modelEvaluation"]);
  assert.deepEqual(different.content.state.modelEvaluation, { status: "failed" });
});

test("compactRecord：已知 guard 问题集折叠成 {ref, sha256, bytes}", () => {
  const record = richRecord();
  const compacted = compactRecord(record);
  const folded = compacted.content.questions;
  assert.equal(folded.ref, GUARD_QUESTIONS_VERSION);
  assert.match(folded.sha256, /^[0-9a-f]{64}$/);
  assert.ok(folded.bytes > 100, `应记录字节数：${folded.bytes}`);
  // 展开后还原成同一份定义（深比较）。
  assert.deepEqual(expandRecord(compacted).content.questions, guardQuestions());
});

test("compactRecord：未知问题集原样保留（不猜、不做有损折叠）", () => {
  const questions = { q: { type: "noul", instructions: "x" } };
  const compacted = compactRecord(richRecord({ content: { questions } }));
  assert.deepEqual(compacted.content.questions, questions);
  assert.deepEqual(expandRecord(compacted).content.questions, questions);
});

test("compactRecord：省略默认空值，expandRecord 补回", () => {
  const record = richRecord({ tag: "", topMode: "", model: "", action: "", detail: "" });
  const compacted = compactRecord(record);
  for (const key of ["tag", "topMode", "model", "action", "detail"]) {
    assert.equal(Object.hasOwn(compacted, key), false, `${key} 的空串应被省略`);
  }
  // latencyMs 不是 0，必须保留。
  assert.equal(compacted.latencyMs, 1200);

  const zero = compactRecord(richRecord({ latencyMs: 0, inputTokens: 0, outputTokens: 0 }));
  assert.equal(Object.hasOwn(zero, "latencyMs"), false);
  assert.equal(Object.hasOwn(zero, "inputTokens"), false);
  assert.equal(Object.hasOwn(zero, "outputTokens"), false);

  const expanded = expandRecord(compacted);
  assert.equal(expanded.tag, "");
  assert.equal(expanded.model, "");
});

test("compactRecord：capture / capture='meta' 不省略（读取端与界面都靠它）", () => {
  const compacted = compactRecord(richRecord({ capture: "meta", content: undefined }));
  assert.equal(compacted.capture, "meta");
  assert.equal(expandRecord(compacted).capture, "meta");
});

test("compactRecord 不修改入参；非对象原样返回", () => {
  const record = richRecord();
  const snapshot = JSON.stringify(record);
  compactRecord(record);
  assert.equal(JSON.stringify(record), snapshot, "入参必须保持原样");
  assert.equal(compactRecord(null), null);
  assert.equal(compactRecord(undefined), undefined);
  assert.deepEqual(compactRecord([1, 2]), [1, 2]);
  assert.equal(expandRecord(null), null);
});

test("紧凑化幂等：expand ∘ compact 再 compact 与直接 compact 等价", () => {
  const record = richRecord();
  const once = compactRecord(record);
  const twice = compactRecord(expandRecord(once));
  assert.deepEqual(twice, once);
});

test("expandRecord：折叠引用哈希对不上时不还原（定义改过）", () => {
  const compacted = compactRecord(richRecord());
  compacted.content.questions = { ...compacted.content.questions, sha256: "0".repeat(64) };
  const expanded = expandRecord(compacted);
  // 哈希不匹配 → 保持折叠引用（宁可让界面看到引用，也不造假内容）。
  assert.equal(expanded.content.questions.ref, GUARD_QUESTIONS_VERSION);
  assert.equal(expanded.content.questions.sha256, "0".repeat(64));
});

test("expandRecord：缺省字段补齐（读端信任字段形状）", () => {
  const expanded = expandRecord({ v: 1, ts: "t", sessionId: "s", point: "authorize" });
  assert.equal(expanded.tag, "");
  assert.equal(expanded.topMode, "");
  assert.equal(expanded.model, "");
  assert.equal(expanded.action, "");
  assert.equal(expanded.detail, "");
  assert.equal(expanded.cached, false);
  assert.equal(expanded.degraded, false);
  assert.equal(expanded.latencyMs, 0);
  assert.equal(expanded.inputTokens, 0);
  assert.equal(expanded.outputTokens, 0);
});
