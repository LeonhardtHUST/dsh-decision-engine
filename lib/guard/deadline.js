export function guardReviewBudget(config) {
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(1, config.timeoutMs) : 20000;
  return Number.isFinite(config.guardDeadlineMs) && config.guardDeadlineMs > 0
    ? Math.min(config.guardDeadlineMs, 2147483647)
    : Math.min(timeoutMs * 2, 30000);
}

export function createReviewDeadline({ timeoutMs, signal }) {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const timeoutError = new Error("review-timeout");
  let timedOut = false;
  const expire = () => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(timeoutError);
  };
  const cancel = () => controller.abort(signal.reason);
  const timer = setTimeout(expire, timeoutMs);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const check = () => {
    if (!controller.signal.aborted && performance.now() >= expiresAt) expire();
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("review-cancelled");
  };
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get remainingMs() { return Math.max(0, expiresAt - performance.now()); },
    async run(operation) {
      check();
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason ?? new Error("review-cancelled"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => { check(); return operation(controller.signal); }), aborted]);
        check();
        return result;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.abort(new Error("review-finished"));
    },
  };
}
