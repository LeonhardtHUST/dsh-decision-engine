/**
 * 决策日志的**纯函数**层：分片命名、文件名清洗、记录紧凑化。
 *
 * ## 为什么把这些搬出 decision-store.js
 *
 * 存储层（`DecisionStore`）要碰文件系统，测试它必须造目录、收尾清理；
 * 而「日期键怎么算」「文件名怎么洗」「记录怎么压」这三件事全是**纯变换**：
 * 同样的输入永远给同样的输出，一次也不碰磁盘。把它们单独放在这里，
 * 就能用一个文件把边界全钉死（时区、Windows 保留名、截断哈希、往返压缩），
 * 不必为了验一个字符就建临时目录。
 *
 * ## 三个必须留在这里的理由
 *
 * 1. **日期键不能用 `toISOString().slice(0, 10)`**。那是 UTC 日期：在
 *    Asia/Shanghai（UTC+8）凌晨 00:30 写下的记录会被记到**前一天**，
 *    于是「今天的日志」里看不到今天的记录，跨零点还会把一天拆成两半。
 *    这里一律用 `Intl.DateTimeFormat.formatToParts` 按**配置时区**取年月日。
 * 2. **文件名里可能有会话名 / 工作区名**。它们是用户内容：要过 NFKC、
 *    剔除路径分隔符与控制字符、避开 Windows 保留设备名，再截断；发生
 *    改动或截断时追加短哈希，保证两个不同的名字不会落到同一个文件上
 *    （否则两个会话的日志会串在一起）。
 * 3. **紧凑化必须可逆**。删掉的字段都带「还原依据」：与 `scores` 逐字节
 *    相同的 `modelEvaluation` 记在 `dedup` 里，已知问题集折叠成
 *    `{ref, sha256, bytes}`，默认空值有固定的缺省表。读取路径一律先
 *    `expandRecord()`，界面拿到的记录与写盘前**同形**。
 *
 * @module dsh-decision-engine/decision-log
 */

import { createHash } from "node:crypto";

import { GUARD_QUESTIONS_VERSION, guardQuestions } from "./guard/advisory.js";

// ---------------------------------------------------------------- 常量

/** 分文件模式的四种取值。 */
export const SPLIT_MODES = ["single", "date", "session", "workspace"];

/**
 * 默认分文件模式：**按日期**。
 *
 * 为什么默认不是「按会话」：用户问「今天的日志」比问「某个会话的日志」更
 * 常见；而按会话/工作区分文件会让文件名带上用户内容（见模块头隐私说明），
 * 默认取信息量最小的那个维度。
 */
export const DEFAULT_SPLIT_MODE = "date";

/** 日期分隔符的可选值。 */
export const DATE_SEPARATORS = ["-", "_", "."];

/** 默认日期分隔符（与前缀 `YYYY-MM-DD` 的直觉一致）。 */
export const DEFAULT_DATE_SEPARATOR = "-";

/** 默认保留天数；0 = 不按天删（只受总量上限约束）。 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 默认日志总量上限：64 MB。 */
export const DEFAULT_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

/** 文件名里会话名 / 工作区名的默认最大长度（按码点算，哈希后缀另计）。 */
export const DEFAULT_SEGMENT_MAX_LENGTH = 48;

/** 会话 id 在文件名里保留的字符数。 */
export const SESSION_ID_SEGMENT_LENGTH = 8;

/** 单一文件模式的默认文件名（也是旧版本唯一的文件名，兼容用它）。 */
export const SINGLE_FILE_NAME = "decisions.jsonl";

/** 已知问题集折叠后的引用名（与 guard/advisory.js 的版本常量同源）。 */
export const QUESTIONS_REF = GUARD_QUESTIONS_VERSION;

/**
 * 紧凑化时**可以省略**的空串字段。
 *
 * 只挑「读端一定知道缺省值」的展示型字段：它们占了每条记录几十字节，
 * 而内容一个字节都没少。身份字段（`v` / `seq` / `id` / `ts` / `sessionId` /
 * `point` / `mode` / `capture`）**绝不省略**——读端的会话预筛（按
 * `"sessionId":"…"` 子串判断）与「不可归属」判定都直接依赖它们。
 */
const OMIT_EMPTY_STRINGS = ["tag", "topMode", "model", "action", "detail"];

/** 紧凑化时**可以省略**的 0 值字段（读端按 0 还原）。 */
const OMIT_ZERO_NUMBERS = ["latencyMs", "inputTokens", "outputTokens"];

/**
 * 展开时补回的默认值表。
 *
 * 字段集合必须与 `buildDecisionRecord()` 的输出对齐：缺了哪个，界面就会
 * 在「写盘前有的字段、读回来后没有」这种形态下翻车（表格列忽然变成 `—`）。
 */
const EXPAND_DEFAULTS = {
  tag: "",
  topMode: "",
  model: "",
  action: "",
  detail: "",
  cached: false,
  degraded: false,
  latencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** 非法文件名字符：Windows 保留的 `<>:"/\|?*` 加上 C0 / C1 控制字符。 */
const ILLEGAL_IN_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;

/** Windows 保留设备名（含带扩展名的形态，如 `con.txt`）。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// ---------------------------------------------------------------- 日期

/**
 * 把任意时间表示归一成 `Date`。
 *
 * 非法输入返回**当前时间**而不是 `Invalid Date`：分片名必须永远可算，
 * 一条 ts 坏掉的记录不该让整条写盘链路炸掉（旁路永远不拖累主流程）。
 *
 * @param ts - ISO 字符串 / 毫秒数 / Date / 可被 Date 解析的字符串。
 * @returns 合法 Date。
 */
function toDate(ts) {
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? new Date() : ts;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }
  if (typeof ts === "string" && ts.trim().length > 0) {
    const date = new Date(ts.trim());
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * 取某时刻在指定时区下的日期键（`YYYY-MM-DD`）。
 *
 * 为什么不用 `toISOString().slice(0, 10)`：那是 UTC 日期。东八区凌晨
 * 00:30 的记录会被算到前一天（`2026-11-15T16:30Z` → `2026-11-15`），
 * 「今天的日志」里就看不到今天凌晨的记录。这里按 `timeZone` 取本地年月日，
 * 与用户看到的日历一致。
 *
 * @param ts - 时间（ISO 字符串 / 毫秒数 / Date）。
 * @param timeZone - IANA 时区名（如 `Asia/Shanghai`）；留空用系统时区。
 * @returns `YYYY-MM-DD`；日期取不到时退回空串（调用方按「无日期」处理）。
 */
export function dateKeyOf(ts, timeZone) {
  const date = toDate(ts);
  const wanted = typeof timeZone === "string" && timeZone.trim().length > 0 ? timeZone.trim() : undefined;
  const options = { year: "numeric", month: "2-digit", day: "2-digit" };
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", wanted === undefined ? options : { ...options, timeZone: wanted })
      .formatToParts(date);
  } catch {
    // 时区名写错了不该拖垮写盘：退回系统时区，日期仍可用。
    try {
      parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
    } catch {
      return "";
    }
  }
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 系统时区（IANA 名）；拿不到返回 `UTC`。 */
export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ---------------------------------------------------------------- 文件名

/** 规范化分文件模式；无法识别时退回默认档。 */
export function normalizeSplitMode(value) {
  return SPLIT_MODES.includes(value) ? value : DEFAULT_SPLIT_MODE;
}

/** 规范化日期分隔符；无法识别时退回默认档。 */
export function normalizeDateSeparator(value) {
  return DATE_SEPARATORS.includes(value) ? value : DEFAULT_DATE_SEPARATOR;
}

/** sha1 十六进制摘要。 */
function sha1Hex(text) {
  return createHash("sha1").update(String(text), "utf8").digest("hex");
}

/** sha256 十六进制摘要。 */
function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** 取第一个非空字符串。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/**
 * 把用户内容洗成**可安全放进文件名**的一段。
 *
 * 处理顺序（顺序本身有意义）：
 *
 *   1. NFKC 归一——全角 `Ａ` / 兼容字符先折叠，否则同一个名字会因输入法
 *      差异落成两个文件；
 *   2. 非法字符与 C0/C1 控制字符替换为 `_`（路径分隔符出现在文件名里，
 *      Windows 会把它当目录，直接写失败）；
 *   3. 折叠连续空白 / 下划线 / 点，再去掉首尾的点与空格（Windows 会静默
 *      吃掉结尾的点，导致「写了却读不到」）；
 *   4. Windows 保留设备名加前缀 `_`（`CON`、`CON.txt` 这类名字建不出来）；
 *   5. 按**码点**截断（不能按 UTF-16 代码单元切：会把 emoji / 生僻字劈成
 *      半个代理对，文件名就变成乱码）；
 *   6. 空串 → `unknown`。
 *
 * 冲突兜底：只要清洗**改动过**原文或发生截断，就在末尾追加 `~<sha1 前 6 位>`
 * （对 NFKC 后的原文取哈希）。两个不同的长名字共享前 48 个码点时不会
 * 撞进同一个文件；而没被改动过的名字保持原样，排查时一眼能认出来。
 *
 * @param name - 原始名字（会话名 / 工作区名 / id）。
 * @param options.maxLength - 最大码点数，默认 48；哈希后缀不计入。
 * @returns 安全的分名片段；永不返回空串。
 */
export function sanitizeSegment(name, options = {}) {
  const requested = Number(options.maxLength);
  const maxLength = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.floor(requested))
    : DEFAULT_SEGMENT_MAX_LENGTH;
  const source = name === undefined || name === null ? "" : String(name);
  const normalized = source.normalize("NFKC");
  let text = normalized
    .replace(ILLEGAL_IN_NAME, "_")
    .replace(/\s+/gu, " ")
    .replace(/_+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[. ]+|[. ]+$/g, "");
  if (RESERVED_NAME.test(text)) text = `_${text}`;
  const codePoints = Array.from(text);
  const truncated = codePoints.length > maxLength;
  if (truncated) text = codePoints.slice(0, maxLength).join("");
  if (text.length === 0) return "unknown";
  if (truncated || text !== normalized) return `${text}~${sha1Hex(normalized).slice(0, 6)}`;
  return text;
}

/**
 * 算出一分片的文件名（不含目录）。
 *
 * 四种模式：
 *
 *   - `single`    → `decisions.jsonl`（旧版本的唯一文件，升级后仍可读）
 *   - `date`      → `YYYY<sep>MM<sep>DD.log`
 *   - `session`   → `<clean(会话名或会话id)>__<sessionId 前 8>.log`
 *   - `workspace` → `<clean(工作区名)>.log`
 *
 * 会话模式为什么要带 id 后缀：会话标题可以重名（「新会话」），只按名字
 * 分文件会让两个会话的日志串在一起；id 前 8 位足以在单机范围内区分，
 * 又不会把文件名撑得太长。
 *
 * @param options.splitMode - 分文件模式。
 * @param options.ts - 记录时间（date 模式用）。
 * @param options.timeZone - IANA 时区（date 模式用）。
 * @param options.separator - 日期分隔符（date 模式用）。
 * @param options.sessionId - 会话 id（session 模式用）。
 * @param options.sessionName - 会话名（session 模式用；空则退化为 id）。
 * @param options.workspaceName - 工作区名（workspace 模式用）。
 * @param options.fileName - single 模式的文件名，默认 `decisions.jsonl`。
 * @returns 文件名；任何模式下都不含路径分隔符。
 */
export function shardFileName(options = {}) {
  const mode = normalizeSplitMode(options.splitMode);
  if (mode === "single") {
    const name = firstNonEmpty(options.fileName, SINGLE_FILE_NAME);
    return name;
  }
  if (mode === "date") {
    const separator = normalizeDateSeparator(options.separator);
    const key = dateKeyOf(options.ts, options.timeZone) || dateKeyOf(Date.now(), options.timeZone);
    return `${key.replaceAll("-", separator)}.log`;
  }
  if (mode === "session") {
    const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
    const idPart = sanitizeSegment(
      sessionId.length > 0 ? sessionId.slice(0, SESSION_ID_SEGMENT_LENGTH) : "unknown",
      { maxLength: SESSION_ID_SEGMENT_LENGTH },
    );
    const readable = firstNonEmpty(options.sessionName, sessionId, "unknown");
    return `${sanitizeSegment(readable)}__${idPart}.log`;
  }
  const workspace = firstNonEmpty(options.workspaceName, "unknown");
  return `${sanitizeSegment(workspace)}.log`;
}

/**
 * 从分片文件名里解出日期（保留期判断用）。
 *
 * 接受三种分隔符与轮转后缀：`2026-11-15.log`、`2026-11-15.1.log`、
 * `2026_11_15.log`、`2026.11.15.log`。不是日期分片（会话/工作区/单一文件）
 * 返回 `null`——调用方会退回用 mtime 判断保留期。
 *
 * 校验必须严格：`2026-13-45` 这种「看起来是日期」的名字不能被当成
 * 合法分片，否则保留期清理会按一个不存在的日期算出错误的截止点。
 *
 * @param fileName - 文件名或路径。
 * @returns `{ year, month, day, key, rotation }`；无法解析返回 `null`。
 */
export function parseShardDate(fileName) {
  const name = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const matched = /^(\d{4})([-_.])(\d{2})\2(\d{2})(?:[.](\d+))?[.]log$/i.exec(name);
  if (matched === null) return null;
  const year = Number(matched[1]);
  const month = Number(matched[3]);
  const day = Number(matched[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    key: `${matched[1]}-${matched[3]}-${matched[4]}`,
    rotation: matched[5] === undefined ? 0 : Number(matched[5]),
  };
}

/** 轮转后的文件名：`x.log` → `x.1.log`；`x.jsonl` → `x.jsonl.1`。 */
export function rotatedNameOf(fileName) {
  const name = String(fileName ?? "");
  if (name.endsWith(".log")) return `${name.slice(0, -4)}.1.log`;
  return `${name}.1`;
}

// ---------------------------------------------------------------- 紧凑格式

/** JSON 深拷贝；不可序列化时返回 `undefined`。 */
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** 稳定的 JSON 文本；失败返回 `undefined`（用于「逐字节相同」的比较）。 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * 紧凑化一条记录（写盘前调用）。
 *
 * 三件事，全部**可逆**：
 *
 * 1. **去重 `modelEvaluation`**：授权点的 `scores.modelEvaluation` 与
 *    `content.state.modelEvaluation` / `content.answers.modelEvaluation`
 *    是同一份对象（见 lib/guard/listener.js），一条记录里存三遍。只有与
 *    `scores` **逐字节相同**时才删——不同的内容可能是别的现场，不能猜。
 *    删掉的位置记进 `dedup`，读取时照原样补回。
 * 2. **折叠已知问题集**：守卫的问题集定义是常量（`guardQuestions()`），
 *    每条记录都带一份纯属浪费。折叠成 `{ref, sha256, bytes}`，读取时
 *    在哈希一致的前提下还原。
 * 3. **省略默认空值**：空串 / `false` / `0` 这些「缺省就是它」的展示字段。
 *
 * @param record - 一条决策明细记录。
 * @returns 新的紧凑记录；入参非法时原样返回。
 */
export function compactRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const source = cloneJson(record);
  if (source === null || typeof source !== "object" || Array.isArray(source)) return record;

  // 1) modelEvaluation 去重（只有逐字节相同才动）。
  const scoresEvaluation = source.scores?.modelEvaluation;
  if (scoresEvaluation !== undefined) {
    const expected = safeStringify(scoresEvaluation);
    const deduped = [];
    for (const slot of ["state", "answers"]) {
      const holder = source.content?.[slot];
      if (holder === null || typeof holder !== "object") continue;
      if (!Object.hasOwn(holder, "modelEvaluation")) continue;
      if (safeStringify(holder.modelEvaluation) !== expected) continue;
      delete holder.modelEvaluation;
      deduped.push(`${slot}.modelEvaluation`);
    }
    if (deduped.length > 0) source.dedup = deduped;
  }

  // 2) 已知问题集折叠（哈希写进引用，读取时用来确认「还是同一份定义」）。
  const content = source.content;
  if (content !== null && typeof content === "object" && content.questions !== null && typeof content.questions === "object") {
    const known = guardQuestions();
    const knownText = safeStringify(known);
    if (knownText !== undefined && safeStringify(content.questions) === knownText) {
      content.questions = {
        ref: QUESTIONS_REF,
        sha256: sha256Hex(knownText),
        bytes: Buffer.byteLength(knownText, "utf8"),
      };
    }
  }

  // 3) 省略默认空值。
  for (const key of OMIT_EMPTY_STRINGS) {
    if (source[key] === "") delete source[key];
  }
  for (const key of OMIT_ZERO_NUMBERS) {
    if (source[key] === 0) delete source[key];
  }
  if (source.cached === false) delete source.cached;
  if (source.degraded === false) delete source.degraded;

  return source;
}

/**
 * 还原一条紧凑记录（读取路径必须**先**调用它）。
 *
 * 与 `compactRecord()` 严格对称：补回 `dedup` 删掉的两个位置、按 ref 展开
 * 已知问题集、补回默认空值。任何一步拿不到依据时**保持原样**——宁可让
 * 界面看到折叠后的引用，也不凭空造一份「看起来一样」的内容。
 *
 * 两点必须说清（否则会被误当成缺陷）：
 *
 *   1. **老记录会被补齐成当前形状**。升级前落盘的记录本来就没有 `tag` /
 *      `latencyMs` 这些字段（早期的 `buildDecisionRecord` 还没写它们），
 *      展开时会按默认值补上，与今天的记录同形——这正是界面想要的。
 *   2. **字段顺序不保证逐字节一致**。还原的 `modelEvaluation` 会追加在对象
 *      末尾；语义（深比较）完全相同，但 `JSON.stringify` 的字节序可能变。
 *      任何依赖「逐字节相同」的比较都不要放在读取路径上。
 *
 * @param record - 从磁盘读出的记录（可能是紧凑格式）。
 * @returns 还原后的记录；入参非法时原样返回。
 */
export function expandRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const source = cloneJson(record);
  if (source === null || typeof source !== "object" || Array.isArray(source)) return record;

  // 1) 问题集还原：哈希必须对得上（定义改过就说明不是同一份，不能还原成新版）。
  const content = source.content;
  if (content !== null && typeof content === "object" && content.questions !== null && typeof content.questions === "object") {
    const folded = content.questions;
    if (folded.ref === QUESTIONS_REF && typeof folded.sha256 === "string") {
      const known = guardQuestions();
      const knownText = safeStringify(known);
      if (knownText !== undefined && sha256Hex(knownText) === folded.sha256) {
        content.questions = known;
      }
    }
  }

  // 2) modelEvaluation 还原：依据只有 scores 里那一份。
  if (Array.isArray(source.dedup)) {
    const scoresEvaluation = source.scores?.modelEvaluation;
    for (const entry of source.dedup) {
      const [slot, field] = String(entry).split(".");
      if ((slot !== "state" && slot !== "answers") || field !== "modelEvaluation") continue;
      if (scoresEvaluation === undefined) continue;
      if (source.content === null || typeof source.content !== "object") source.content = {};
      if (source.content[slot] === null || typeof source.content[slot] !== "object") {
        source.content[slot] = {};
      }
      if (!Object.hasOwn(source.content[slot], "modelEvaluation")) {
        source.content[slot].modelEvaluation = cloneJson(scoresEvaluation);
      }
    }
    delete source.dedup;
  }

  // 3) 缺省字段补回（与 buildDecisionRecord 的输出对齐）。
  for (const [key, value] of Object.entries(EXPAND_DEFAULTS)) {
    if (!Object.hasOwn(source, key)) source[key] = value;
  }

  return source;
}
