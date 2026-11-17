import test from "node:test";
import assert from "node:assert/strict";
import { reviewFailure } from "../lib/guard/review-failure.js";

const canary = "private-canary-https://secret.invalid/?token=fixture";

test("review failure copies only enum code and valid numeric status from host shape", () => {
  for (const code of ["QUOTA", "AUTH", "RATE_LIMIT", "ACCOUNT_QUOTA", "UNKNOWN"]) {
    assert.deepEqual(reviewFailure("finish", { failure: { code, status: 429, message: canary, requestId: canary, body: canary, rawHeaders: canary } }, "error"), {
      stage: "finish", code, httpStatus: 429, finishReason: "error",
    });
  }
  for (const code of [canary, "quota", "ECONNRESET", "toString", null, {}]) {
    const result = reviewFailure("finish", { failure: { code, message: canary } }, canary);
    assert.deepEqual(result, { stage: "finish", code: "UNKNOWN", httpStatus: null, finishReason: null });
    assert.ok(!JSON.stringify(result).includes(canary));
  }
});

test("review failure rejects out-of-range statuses and does not invoke foreign accessors", () => {
  for (const status of [99, 600, 429.5, "429", NaN, Infinity, null]) {
    assert.equal(reviewFailure("stream", { code: "AUTH", status }).httpStatus, null);
  }
  for (const status of [100, 599]) assert.equal(reviewFailure("stream", { status }).httpStatus, status);
  const hostile = Object.defineProperties({}, {
    code: { get() { throw new Error(canary); } },
    status: { get() { throw new Error(canary); } },
    failure: { get() { throw new Error(canary); } },
    message: { get() { throw new Error(canary); } },
  });
  assert.deepEqual(reviewFailure("sdk", hostile), { stage: "sdk", code: "UNKNOWN", httpStatus: null, finishReason: null });
  assert.deepEqual(reviewFailure("sdk", new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(canary); } })), { stage: "sdk", code: "UNKNOWN", httpStatus: null, finishReason: null });
});
