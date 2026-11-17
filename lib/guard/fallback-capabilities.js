/**
 * 回退模型「思考档位」能力预检。
 *
 * 为什么要单独成模块：回退审查（`reviewWithFallback`）和设置页的连接性测试
 * 走的是同一条 `llm.stream` 链路，两处都必须用同一个判断——否则「测试按钮
 * 说通、真正审查却因档位不支持而失败」还会再出现一次。这里只做纯查询，
 * 不缓存：宿主的路由与能力元数据可以随配置、模型切换变化，缓存一次就会在
 * 下一次审查里拿旧答案做决定。
 *
 * 判断口径与宿主 `LlmRuntime.resolveCallConfig` 一致：
 *   - 没有显式 `reasoningEffort`：不选最小值、不替调用方兜底，交宿主默认；
 *   - 显式档位在 exact model 的 `reasoning.efforts[].id` 里：通过；
 *   - 显式档位不在其中，或该模型没有 reasoning 元数据：不支持；
 *   - 宿主没有 `resolveModelInfo`：保留原来的 SDK 验证路径，不冒充预检成功；
 *   - 元数据非法或查询抛错：保守失败，只带白名单分类，不回显原文。
 *
 * @module dsh-decision-engine/lib/guard/fallback-capabilities
 */

import { reviewFailure } from "./review-failure.js";

/** 显式思考档位与 exact model 能力不匹配时的固定原因码。 */
export const FALLBACK_INCOMPATIBLE_REASON = "fallback-model-incompatible";

const INVALID_MODEL_INFO = "INVALID_MODEL_INFO";
const INVALID_MODEL_REASONING = "INVALID_MODEL_REASONING";

/**
 * 只有显式给出的档位才需要预检。空字符串等同于未配置——与
 * `fallbackSelection` 对配置项做 `trim()` 后省略的行为一致。
 *
 * @param selection - `{ provider, model, reasoningEffort? }`。
 * @returns 需要核对的档位 id，或 `undefined`。
 */
function explicitEffort(selection) {
  const effort = selection?.reasoningEffort;
  return typeof effort === "string" && effort.length > 0 ? effort : undefined;
}

/**
 * 不支持的固定失败：不携带任何异常原文、模型输出或请求信息。
 *
 * @returns `{ stage: "selection", code: "UNSUPPORTED_REASONING_EFFORT", httpStatus: null, finishReason: null }`。
 */
function incompatibleFailure() {
  return reviewFailure("selection", { code: "UNSUPPORTED_REASONING_EFFORT" }, null);
}

/**
 * 元数据问题的保守失败。只保留白名单错误码；`httpStatus` 固定为空，
 * 避免把适配器异常里偶然带的数字当成真实 HTTP 状态展示出去。
 *
 * @param code - 白名单内的分类码（如 INVALID_MODEL_INFO）。
 */
function metadataFailure(code) {
  return reviewFailure("selection", { code }, null);
}

/**
 * 把一次 `resolveModelInfo` 的结果压成「这个显式档位到底能不能用」。
 *
 * 不信任适配器返回的形状：`resolveModelInfo` 正常会校验，但旧宿主、测试桩
 * 或第三方适配器都可能给出不完整对象。这里宁可判为「无法确认」，也不从
 * 缺失字段里推断出 supported。
 *
 * @param info - `LlmResolvedModelInfo`（或它的伪造版本）。
 * @param selection - 原始路由，用于核对 exact model 身份。
 * @param effort - 显式档位 id。
 */
function classifyInfo(info, selection, effort) {
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    return { status: "unverifiable", failure: metadataFailure(INVALID_MODEL_INFO) };
  }
  if (
    typeof info.provider !== "string"
    || info.provider !== selection.provider
    || typeof info.id !== "string"
    || info.id !== selection.model
    || typeof info.name !== "string"
    || info.name.length === 0
  ) {
    return { status: "unverifiable", failure: metadataFailure(INVALID_MODEL_INFO) };
  }
  const reasoning = info.reasoning;
  // 与宿主一致：没有 reasoning 元数据时，显式档位视为不支持。不能把
  // 「没声明」读成「支持」，否则预检会给出虚假的安全感。
  if (reasoning === undefined) return { status: "incompatible", failure: incompatibleFailure() };
  if (
    reasoning === null
    || typeof reasoning !== "object"
    || Array.isArray(reasoning)
    || !Array.isArray(reasoning.efforts)
    || reasoning.efforts.length === 0
  ) {
    return { status: "unverifiable", failure: metadataFailure(INVALID_MODEL_REASONING) };
  }
  const seen = new Set();
  for (const item of reasoning.efforts) {
    if (
      item === null
      || typeof item !== "object"
      || typeof item.id !== "string"
      || item.id.length === 0
      || typeof item.name !== "string"
      || item.name.length === 0
      || seen.has(item.id)
    ) {
      return { status: "unverifiable", failure: metadataFailure(INVALID_MODEL_REASONING) };
    }
    seen.add(item.id);
  }
  if (
    reasoning.defaultEffort !== undefined
    && (typeof reasoning.defaultEffort !== "string" || !seen.has(reasoning.defaultEffort))
  ) {
    return { status: "unverifiable", failure: metadataFailure(INVALID_MODEL_REASONING) };
  }
  return seen.has(effort) ? { status: "supported" } : { status: "incompatible", failure: incompatibleFailure() };
}

/**
 * 让能力查询与取消/超时竞速。查询本身可能永不返回，也可能在 abort 之后才
 * 返回；两种情况下调用方都必须能先拿到一个明确结论，且不能留下监听器。
 *
 * @param start - 启动查询的同步函数。
 * @param signal - 可选的取消信号。
 */
function raceAbort(start, signal) {
  const pending = Promise.resolve().then(start);
  if (signal === undefined) return pending;
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("review-cancelled"));
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("review-cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([pending, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/**
 * 预检回退模型的思考档位能力。
 *
 * 返回的 `status` 含义：
 *   - `host-default`：没有显式档位，什么都没查，交宿主默认（不是「预检通过」）；
 *   - `legacy-sdk-validation`：宿主没有 `resolveModelInfo`，沿用原 SDK 验证路径
 *     （不是「预检通过」，也不额外放行）；
 *   - `supported`：exact model 的元数据明确列出了该档位；
 *   - `incompatible`：元数据明确不支持（或没有 reasoning 元数据），调用方必须
 *     在 `llm.stream` 前拒绝；
 *   - `unverifiable`：元数据非法或查询抛错，带保守的 `failure` 分类。
 *
 * 取消/超时会直接抛出信号原因，方便调用方保留既有的 cancel/timeout 原因码。
 *
 * @param options.llm - 宿主 LLM 服务（需要其 `resolveModelInfo`）。
 * @param options.selection - `{ provider, model, reasoningEffort? }`，原样保留。
 * @param options.signal - 共享的取消/超时信号。
 * @returns 预检结论。
 */
export async function preflightFallbackCapabilities({ llm, selection, signal } = {}) {
  const effort = explicitEffort(selection);
  if (effort === undefined) return { status: "host-default" };
  if (typeof llm?.resolveModelInfo !== "function") return { status: "legacy-sdk-validation" };
  if (signal?.aborted) throw signal.reason ?? new Error("review-cancelled");
  let info;
  try {
    info = await raceAbort(() => llm.resolveModelInfo(selection.provider, selection.model, signal), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const rawCode = error?.failure?.code ?? error?.code;
    // 适配器若直接从查询里报「不支持这个档位」，仍归入同一个固定原因。
    if (rawCode === "UNSUPPORTED_REASONING_EFFORT") {
      return { status: "incompatible", failure: incompatibleFailure() };
    }
    const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : undefined;
    return {
      status: "unverifiable",
      failure: code === undefined ? reviewFailure("selection", null, null) : metadataFailure(code),
    };
  }
  if (signal?.aborted) throw signal.reason ?? new Error("review-cancelled");
  return classifyInfo(info, selection, effort);
}
