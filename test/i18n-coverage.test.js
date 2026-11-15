/**
 * 静态的**词典覆盖**测试：源码里每个会被渲染的中文文案，在词表里都有一席之地。
 *
 * 为什么渲染测试之外还要这一层：渲染测试只能覆盖**它走到的分支**。新增一段
 * 提示文案时，如果那个分支测试没走到，漏翻要到用户切到英文才被发现。
 * 这里不渲染、只比对源码与词表，能在提交时立刻指出「这句中文没有英文」。
 *
 * 反过来说：本测试只保证「登记了」，不保证「翻对了」——翻错由人看，
 * 漏翻由这里兜。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const LINES = SOURCE.split("\n");

/** 中文字符（含全角标点）。 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 注释行。`//` 会结束正则字面量，所以用构造函数。 */
const COMMENT = new RegExp("^\\s*(\\*|//|/\\*)");

const STATIC_TABLES = ["EN_CONFIG", "EN_STATS", "EN_MISC", "EN_LABELS"];
const TEMPLATE_TABLES = ["T_CONFIG", "T_STATS", "T_MISC"];
const ALL_TABLES = [...STATIC_TABLES, ...TEMPLATE_TABLES];

/**
 * **独立**的裁决词表（T4）：`VERDICT_TEXT_ZH` / `VERDICT_TEXT_EN`。
 *
 * 它们故意**不并入** `EN` / `T`（`tr()` 用的那两张合并表）：裁决格里的
 * 「放行 / 拦截」与统计页的「放行 / 拦截」是两套说法，挤进同一张表必然互相
 * 覆盖。但「一个中文词有英文对应」这条仍然要守，所以这里把它们当作
 * **成对词典**处理：字面量扫描跳过（它们本身就是词典），另加一条成对校验
 *（键集相同、英文里没有中文）。
 */
const BILINGUAL_TABLES = ["VERDICT_TEXT_ZH", "VERDICT_TEXT_EN"];

/** 字面量扫描要跳过的区间：所有词典表（合并表 + 独立表）。 */
const SCAN_SKIP_TABLES = [...ALL_TABLES, ...BILINGUAL_TABLES];

/** 取某个 `const NAME = { ... };` 的正文。 */
function tableBody(name) {
  const start = SOURCE.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `client.js 里找不到词表 ${name}`);
  const end = SOURCE.indexOf("\n    };", start);
  assert.ok(end > start, `词表 ${name} 没有闭合`);
  return SOURCE.slice(start, end);
}

/** 词表正文在源码里的字符区间——比对字面量时跳过，否则「词表里有中文」自证通过。 */
const TABLE_RANGES = SCAN_SKIP_TABLES.map((name) => {
  const start = SOURCE.indexOf(`const ${name} = {`);
  const end = SOURCE.indexOf("\n    };", start);
  return [start, end];
});

function inAnyTable(position) {
  return TABLE_RANGES.some(([start, end]) => position >= start && position <= end);
}

/** 每行首字符在源码里的偏移。 */
const LINE_OFFSETS = (() => {
  const out = [];
  let offset = 0;
  for (const line of LINES) {
    out.push(offset);
    offset += line.length + 1;
  }
  return out;
})();

/** 词表里登记的中文 key（静态表 + 模板表）。 */
function tableKeys() {
  const keys = new Set();
  for (const name of ALL_TABLES) {
    for (const match of tableBody(name).matchAll(/\n\s+"((?:[^"\\]|\\.)*)":\s*"/g)) {
      keys.add(JSON.parse(`"${match[1]}"`));
    }
  }
  return keys;
}

/** 取某张表的 `键 → 值`（按行匹配，值里的转义按 JSON 还原）。 */
function tableEntries(name) {
  const out = new Map();
  for (const match of tableBody(name).matchAll(/\n\s+"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/g)) {
    out.set(JSON.parse(`"${match[1]}"`), JSON.parse(`"${match[2]}"`));
  }
  return out;
}

const KEYS = tableKeys();

/**
 * 参与跨行 `"a" + "b"` 拼接链的行号集合（1-based）。
 *
 * 链里的每个片段都不是「一句完整文案」——运行时会被合成一整段。逐片段
 * 检查必然漏报整段，所以这些行交给 `concatenatedParagraphs()` 单独把关。
 */
const CONCAT_LINES = (() => {
  const set = new Set();
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    if (COMMENT.test(line)) continue;
    const following = LINES[i + 1] ?? "";
    const startsContinuation = /^\s*\+\s*"/.test(line);
    const opensChain = /"\s*$/.test(line.trimEnd()) && /^\s*\+\s*"/.test(following);
    if (startsContinuation || opensChain) {
      set.add(i + 1);
      if (opensChain) set.add(i + 2);
    }
  }
  return set;
})();

/**
 * 源码里会被渲染的中文字面量。
 *
 * 排除注释行与词表正文。跨行 `"a" + "b"` 的**片段**也会出现在这里，它们
 * 查表必然命中不了整段（运行时被合成），由第二个测试单独处理。
 */
function renderedLiterals() {
  const found = [];
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    if (COMMENT.test(line)) continue;
    if (!CJK.test(line)) continue;
    // 链里的片段不是完整文案，交给拼接测试把关。
    if (CONCAT_LINES.has(i + 1)) continue;
    for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const text = JSON.parse(`"${match[1]}"`);
      if (!CJK.test(text)) continue;
      if (inAnyTable(LINE_OFFSETS[i] + match.index)) continue;
      found.push({ text, line: i + 1 });
    }
  }
  return found;
}

/**
 * 跨行 `"a" + "b"` 拼接链的**整段**文本。
 *
 * 这类地方运行时会合成一句，逐片段查表必然漏翻；合规写法只有两种：
 * 整段登记进词表，或改成 `t("整句…")`。这里把「两者都没做」的指出来。
 */
function concatenatedParagraphs() {
  const out = [];
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    if (COMMENT.test(line)) continue;
    const first = line.match(/"((?:[^"\\]|\\.)*[\u4e00-\u9fff](?:[^"\\]|\\.)*)"/);
    if (!first) continue;
    const following = LINES.slice(i + 1, i + 3).find((value) => value.trim() !== "");
    if (!following) continue;
    const lineEndsOpen = /"\s*$/.test(line.trimEnd()) || /`\s*$/.test(line.trimEnd());
    const nextStartsConcat = /^\s*\+\s*"/.test(following);
    if (!lineEndsOpen || !nextStartsConcat) continue;

    const segments = [];
    let cursor = i;
    let current = line;
    while (true) {
      for (const match of current.matchAll(/"((?:[^"\\]|\\.)*)"/g)) segments.push(JSON.parse(`"${match[1]}"`));
      const nextLine = LINES[cursor + 1];
      if (!nextLine || !/^\s*\+\s*"/.test(nextLine)) break;
      cursor += 1;
      current = nextLine;
    }
    const whole = segments.join("");
    // 整段只在链的起点报一次（续行不以 + 开头才是起点），避免同一缺口报 N 遍。
    const isContinuation = /^\s*\+\s*"/.test(line);
    if (!isContinuation && CJK.test(whole) && whole.length > 6) out.push({ whole, line: i + 1 });
  }
  return out;
}

test("词表覆盖：源码里渲染的中文文案都有英文", () => {
  const unique = new Map();
  for (const { text, line } of renderedLiterals()) {
    if (!KEYS.has(text) && !unique.has(text)) unique.set(text, line);
  }
  const leftovers = [...unique].map(([text, line]) => `  lib/client.js:${line}  ${text}`);
  assert.deepEqual(
    leftovers.sort(),
    [],
    `以下中文文案没有英文（在 EN_* / T_* 补一条，或改用 t()）：\n${leftovers.join("\n")}`,
  );
});

test("词表覆盖：跨行拼接的整段不会被逐片段漏翻", () => {
  const uncovered = concatenatedParagraphs().filter(({ whole }) => !KEYS.has(whole));
  const locations = uncovered.map(({ whole, line }) => `  lib/client.js:${line}  ${whole.slice(0, 90)}…`);
  assert.deepEqual(
    locations.sort(),
    [],
    `以下整段没有英文（跨行拼接的片段会合成一整句，逐片段登记无效）：\n${locations.join("\n")}`,
  );
});

test("词表：英文译文里不残留中文", () => {
  const offenders = [];
  for (const name of ALL_TABLES) {
    for (const match of tableBody(name).matchAll(/\n\s+"(?:[^"\\]|\\.)*":\s*"((?:[^"\\]|\\.)*)"/g)) {
      const english = JSON.parse(`"${match[1]}"`);
      if (CJK.test(english)) offenders.push(`  ${name}: ${english}`);
    }
  }
  assert.deepEqual(offenders, [], `英文文案里出现了中文：\n${offenders.join("\n")}`);
});

test("词表：每个 key 都有非空英文", () => {
  const empty = [];
  for (const name of ALL_TABLES) {
    for (const match of tableBody(name).matchAll(/\n\s+"((?:[^"\\]|\\.)*)":\s*""/g)) {
      empty.push(`  ${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(empty, [], `空的英文译文：\n${empty.join("\n")}`);
});

// ---------------------------------------------------------------- 独立裁决词表（T4）
//
// 裁决格不再走 `tr()`，而是用自成一对的 `VERDICT_TEXT_ZH` / `VERDICT_TEXT_EN`
//（见 client.js 里那段注释：这些词面与统计页重名却表达不同东西）。
// 「独立」不等于「不用覆盖」——漏一条英文，英文界面那一格就是中文。
// 下面两条把这件事钉住：键集必须一致，英文值里不许有中文，中文值必须真的是中文。

test("独立裁决词表：中英两表键集相同", () => {
  const zh = [...tableEntries("VERDICT_TEXT_ZH").keys()].sort();
  const en = [...tableEntries("VERDICT_TEXT_EN").keys()].sort();
  assert.deepEqual(
    en,
    zh,
    `裁决词表的中英键集不一致（漏一条英文 = 英文界面那一格变回中文）：\n中文：${zh.join(", ")}\n英文：${en.join(", ")}`,
  );
});

test("独立裁决词表：中文是中文、英文里不残留中文", () => {
  const zh = tableEntries("VERDICT_TEXT_ZH");
  const en = tableEntries("VERDICT_TEXT_EN");
  const offenders = [];
  for (const [key, value] of zh) {
    if (!CJK.test(value)) offenders.push(`  VERDICT_TEXT_ZH.${key} 应为中文，实际「${value}」`);
  }
  for (const [key, value] of en) {
    if (CJK.test(value)) offenders.push(`  VERDICT_TEXT_EN.${key} 不应含中文，实际「${value}」`);
  }
  assert.deepEqual(offenders, [], `独立裁决词表有问题：\n${offenders.join("\n")}`);
});
