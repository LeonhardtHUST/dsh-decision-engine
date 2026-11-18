import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_GUARDIAN_MODEL,
  GuardProtocolError,
  buildGuardReviewSystem,
  guardReviewProtocol,
  isCodexGuardianSelection,
  parseGuardReviewAnswer,
} from "../lib/guard/review-protocol.js";

const codex = (extra = {}) => ({ provider: "user-alias", model: CODEX_GUARDIAN_MODEL, ...extra });
const plain = { provider: "host", model: "review" };

/** 只接受两个固定错误码，且 message 必须是固定文案（不回显模型输出）。 */
function rejects(value, selection, code) {
  assert.throws(
    () => parseGuardReviewAnswer(value, selection),
    (error) => {
      assert.ok(error instanceof GuardProtocolError, "必须是协议错误");
      assert.equal(error.code, code);
      assert.ok(
        ["review answer is not one JSON object", "review answer does not match the guard protocol"].includes(error.message),
        "错误文案固定，不能拼进模型输出",
      );
      return true;
    },
  );
}

test("协议只按 exact model id 切换，provider 别名不参与判定", () => {
  assert.equal(isCodexGuardianSelection(codex()), true);
  assert.equal(isCodexGuardianSelection({ model: CODEX_GUARDIAN_MODEL }), true);
  assert.equal(isCodexGuardianSelection({ provider: "codex-proxy", model: CODEX_GUARDIAN_MODEL }), true);
  for (const near of ["Codex-Auto-Review", "codex-auto-review-2", "codex-auto", " codex-auto-review", "codex-auto-review ", ""]) {
    assert.equal(isCodexGuardianSelection({ provider: "codex-proxy", model: near }), false, `近似 id 不能启用 guardian: ${JSON.stringify(near)}`);
  }
  assert.equal(isCodexGuardianSelection({ provider: "codex-proxy" }), false);
  assert.equal(isCodexGuardianSelection(undefined), false);
  assert.equal(isCodexGuardianSelection(null), false);
  assert.equal(isCodexGuardianSelection("codex-auto-review"), false);
  assert.equal(guardReviewProtocol(codex()).mode, "codex-guardian");
  assert.equal(guardReviewProtocol({ provider: "codex-proxy", model: "gpt-6-sol" }).mode, "action");
});

test("guardian system 描述 outcome 协议，普通模型仍是逐字不变的 action prompt", () => {
  const guardian = buildGuardReviewSystem(codex());
  assert.match(guardian, /"outcome"/);
  assert.match(guardian, /"risk_level"/);
  assert.match(guardian, /"user_authorization"/);
  assert.match(guardian, /"rationale"/);
  assert.match(guardian, /no markdown fence/);
  assert.doesNotMatch(guardian, /Return ONLY a JSON object \{"action":"allow"\}/);

  const action = buildGuardReviewSystem(plain);
  assert.match(action, /Return ONLY a JSON object \{"action":"allow"\} or \{"action":"deny"\}/);
  assert.doesNotMatch(action, /risk_level|outcome/);
  assert.equal(buildGuardReviewSystem(undefined), action);
  assert.equal(guardReviewProtocol(codex()).system, guardian);
  assert.equal(guardReviewProtocol(plain).system, action);
});

test("guardian 回答归一成 action，并保留可选证据字段", () => {
  assert.deepEqual(parseGuardReviewAnswer('{"outcome":"allow"}', codex()), { action: "allow" });
  assert.deepEqual(
    parseGuardReviewAnswer('{"outcome":"deny","risk_level":"critical","user_authorization":"low","rationale":"fixture"}', codex()),
    { action: "deny", riskLevel: "critical", userAuthorization: "low", rationale: "fixture" },
  );
  assert.deepEqual(parseGuardReviewAnswer('\n {"outcome":"allow","risk_level":"low"} \n', codex()), { action: "allow", riskLevel: "low" });
  assert.deepEqual(parseGuardReviewAnswer('{"outcome":"deny","user_authorization":"unknown"}', codex({ reasoningEffort: "low" })), { action: "deny", userAuthorization: "unknown" });
});

test("普通模型保持单键 action 协议，guardian 字段算 schema 错", () => {
  assert.deepEqual(parseGuardReviewAnswer('{"action":"allow"}', plain), { action: "allow" });
  assert.deepEqual(parseGuardReviewAnswer('{"action":"deny"}', plain), { action: "deny" });
  rejects('{"action":"allow","risk_level":"low"}', plain, "INVALID_SCHEMA");
  rejects('{"outcome":"allow"}', plain, "INVALID_SCHEMA");
  rejects('{"action":"ask"}', plain, "INVALID_SCHEMA");
});

test("guardian 拒绝未知键、action 混用、枚举与类型错误", () => {
  const cases = [
    '{"outcome":"allow","action":"allow"}',
    '{"outcome":"allow","risk":"low"}',
    '{"outcome":"allow","extra":true}',
    '{"action":"allow"}',
    '{"outcome":"allow","risk_level":"extreme"}',
    '{"outcome":"allow","risk_level":null}',
    '{"outcome":"allow","risk_level":5}',
    '{"outcome":"allow","user_authorization":"sometimes"}',
    '{"outcome":"allow","user_authorization":0}',
    '{"outcome":"allow","rationale":7}',
    '{"outcome":"allow","rationale":null}',
    '{"outcome":"pass"}',
    '{"outcome":true}',
    '{"outcome":"allow","riskLevel":"low"}',
    "{}",
    "[]",
    "null",
    "true",
    '"allow"',
  ];
  for (const text of cases) rejects(text, codex(), "INVALID_SCHEMA");
});

test("guardian 拒绝围栏、散文与不可解析文本，错误码为 INVALID_JSON", () => {
  const canary = "private-protocol-canary";
  for (const text of [
    "allow",
    "",
    `I think ${canary} should be allowed`,
    '```json\n{"outcome":"allow"}\n```',
    '{"outcome":"allow",}',
    `{"outcome":"allow"} ${canary}`,
    `${canary}{"outcome":"allow"}`,
  ]) {
    rejects(text, codex(), "INVALID_JSON");
  }
  for (const value of [undefined, null, 42, {}, []]) rejects(value, codex(), "INVALID_JSON");
});

test("guardReviewProtocol 的 system/parse 与独立 API 一致，且失败不吞错", () => {
  const selection = codex({ reasoningEffort: "medium" });
  const protocol = guardReviewProtocol(selection);
  assert.equal(protocol.system, buildGuardReviewSystem(selection));
  assert.deepEqual(protocol.parse('{"outcome":"deny"}'), parseGuardReviewAnswer('{"outcome":"deny"}', selection));
  assert.throws(() => protocol.parse('{"action":"allow"}'), (error) => error instanceof GuardProtocolError && error.code === "INVALID_SCHEMA");
  assert.throws(() => protocol.parse('{"outcome":"allow"} trailing'), (error) => error instanceof GuardProtocolError && error.code === "INVALID_JSON");
});
