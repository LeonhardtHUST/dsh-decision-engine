import test from "node:test";
import assert from "node:assert/strict";
import { resolveTolerance, severityOf, TOLERANCE_LEVELS } from "../lib/tolerance.js";
import { parseModelAdvisory, decideModelAdvisory } from "../lib/guard/advisory.js";

function advisory(confidence, choice = "medium") {
  return parseModelAdvisory({
    risk: { type: "choice", choice, confidence, confidenceKind: "provider_raw", probabilities: { low: 0.1, medium: 0.6, high: 0.3 } },
    irreversible: { type: "noul", noul: 0.2 }, matches_task: { type: "noul", noul: 0.9 }, injection_suspect: { type: "noul", noul: 0.1 },
  });
}

test("mandatory deny survives every tolerance and every model confidence", () => {
  for (const level of TOLERANCE_LEVELS) {
    for (const confidence of [0.01, 0.6, 0.999, 42]) {
      const parsed = advisory(confidence);
      const result = resolveTolerance({ level, legacyKind: decideModelAdvisory(parsed).kind, severity: severityOf(parsed), mandatory: { status: "deny" }, approvalAvailable: true });
      assert.equal(result.kind, "deny");
    }
  }
});

test("required approval cannot be replaced by model or autonomous tolerance", () => {
  for (const level of TOLERANCE_LEVELS) {
    for (const approvalAvailable of [false, "unknown", undefined]) {
      const result = resolveTolerance({ level, legacyKind: "delegate", severity: 0, mandatory: "requires_approval", approvalAvailable });
      assert.equal(result.kind, "deny");
    }
    assert.equal(resolveTolerance({ level, legacyKind: "delegate", severity: 0, mandatory: { status: "requires_approval", approvalAvailable: true } }).kind, "ask");
  }
});

test("legacy deny remains deny even when mandatory says safe", () => {
  for (const level of TOLERANCE_LEVELS) assert.equal(resolveTolerance({ level, legacyKind: "deny", mandatory: "safe" }).kind, "deny");
});

test("default behavior is unchanged for soft friction with no mandatory constraint", () => {
  for (const legacyKind of ["delegate", "ask", "deny"]) assert.equal(resolveTolerance({ level: "default", legacyKind, severity: 0.99 }).kind, legacyKind);
});

test("confidence, P(choice), and severity remain distinct and uncalibrated", () => {
  const parsed = advisory(0.02);
  assert.equal(parsed.metadata.raw_decision_confidence, 0.02);
  assert.equal(parsed.risk.probabilities.medium, 0.6);
  assert.equal(severityOf(parsed), 0.6);
  assert.equal(parsed.metadata.calibrated_p_unsafe, "unknown");
  assert.equal(decideModelAdvisory(parsed).kind, "ask");
  assert.equal(decideModelAdvisory(advisory(0.99)).kind, "ask");
});
