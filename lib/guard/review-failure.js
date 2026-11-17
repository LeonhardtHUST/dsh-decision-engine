const HOST_FAILURE_CODES = new Set([
  "ABORTED", "ACCOUNT_QUOTA", "ACCOUNT_SIGN_IN_REQUIRED", "ACCOUNT_TOKEN_INVALID", "AUTH",
  "CLIENT_UPGRADE_REQUIRED", "CONTEXT_WINDOW_EXCEEDED", "DISCOVERY_FAILED", "DISCOVERY_UNSUPPORTED",
  "DUPLICATE_ADAPTER", "DUPLICATE_DIRECTORY", "DUPLICATE_DISCOVERY", "EMPTY_RESPONSE", "FILES_API",
  "IMAGE_OFFLOAD_REQUIRED", "INVALID_ADAPTER", "INVALID_CATALOG", "INVALID_CONFIG", "INVALID_CREDENTIAL",
  "INVALID_DIRECTORY", "INVALID_DISCOVERY", "INVALID_MODEL_CONTEXT", "INVALID_MODEL_INFO",
  "INVALID_MODEL_MAX_TOKENS", "INVALID_MODEL_REASONING", "INVALID_PREPARED_CALL", "INVALID_REPLAY_STATE",
  "INVALID_REQUEST", "INVALID_RESPONSE", "MALFORMED_RESPONSE", "MISSING_CREDENTIAL",
  "MODEL_SWITCH_COMPACTION_FAILED", "MODEL_UNSUPPORTED", "NO_ADAPTER", "NO_CREDENTIAL_STORE",
  "NO_DISCOVERY", "PI_AI_ERROR", "QUOTA", "RATE_LIMIT", "REGISTRATION_DISPOSED", "REQUEST_EXTENSION",
  "REQUEST_HEADERS", "SERVER", "STREAM_CLOSED", "TIMEOUT", "TRANSPORT", "UNKNOWN", "UNKNOWN_MODEL",
  "UNSTORABLE_PROVIDER_ID", "UNSUPPORTED_CONTENT", "UNSUPPORTED_OPTION", "UNSUPPORTED_REASONING_EFFORT",
]);
const LOCAL_FAILURE_CODES = new Set([
  "MODEL_UNAVAILABLE", "OUTPUT_LIMIT", "MISSING_FINISH", "INVALID_JSON", "INVALID_SCHEMA", "NON_STOP_FINISH",
]);
const FAILURE_STAGES = new Set(["selection", "sdk", "stream", "finish", "output", "parse", "schema", "deadline", "cancel"]);
const FINISH_REASONS = new Set(["stop", "max-tokens", "tool-calls", "error", "aborted", "content-filter", "other"]);

function ownValue(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function reviewFailure(stage, source, finishReason = null, localCode) {
  const carried = ownValue(source, "failure");
  const failure = carried && typeof carried === "object" ? carried : source;
  const code = ownValue(failure, "code");
  const status = ownValue(failure, "status");
  return {
    stage: FAILURE_STAGES.has(stage) ? stage : "stream",
    code: LOCAL_FAILURE_CODES.has(localCode) ? localCode : HOST_FAILURE_CODES.has(code) ? code : "UNKNOWN",
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    finishReason: FINISH_REASONS.has(finishReason) ? finishReason : null,
  };
}
