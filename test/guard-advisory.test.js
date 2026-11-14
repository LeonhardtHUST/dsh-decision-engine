import test from "node:test";
import assert from "node:assert/strict";
import { guardQuestions, parseModelAdvisory, extractGuardAnswers, decideModelAdvisory } from "../lib/guard/advisory.js";

function answers(overrides = {}) {
  return {
    risk: { type: "choice", choice: "low", confidence: 0.4, confidenceKind: "provider_raw", probabilities: { low: 0.9, medium: 0.08, high: 0.02 } },
    irreversible: { type: "noul", noul: 0.1 },
    matches_task: { type: "noul", noul: 0.9 },
    injection_suspect: { type: "noul", noul: 0.1 },
    ...overrides,
  };
}

test("questions distinguish actual effects, task relevance and injection evidence", () => {
  const questions = guardQuestions();
  assert.deepEqual(Object.keys(questions), ["risk", "irreversible", "matches_task", "injection_suspect"]);
  assert.match(questions.risk.instructions, /independent authorization gate/);
  assert.match(questions.injection_suspect.instructions, /Imperative wording alone is not injection/);
  assert.match(questions.injection_suspect.instructions, /highly task-relevant/);
  assert.match(questions.matches_task.instructions, /not authorization/);
});

test("parsed output preserves original confidence separately from validated probabilities", () => {
  const parsed = parseModelAdvisory(answers());
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.risk.confidence, 0.4);
  assert.equal(parsed.risk.probabilities.low, 0.9);
  assert.equal(parsed.metadata.p_high, 0.02);
  assert.equal(parsed.metadata.p_non_low, 0.1);
  assert.equal(parsed.metadata.calibrated_p_unsafe, "unknown");
  assert.equal(parsed.metadata.authorization_status, "unknown");
});

test("missing scores are unknown, never zero or safe defaults", () => {
  const parsed = parseModelAdvisory({ risk: { type: "choice", choice: "low" } });
  assert.equal(parsed.status, "unknown");
  assert.equal(parsed.irreversibleP, null);
  assert.equal(parsed.taskP, null);
  assert.equal(parsed.injectionP, null);
  assert.equal(parsed.risk.confidence, null);
  assert.equal(parsed.metadata.confidenceKind, "unavailable");
  assert.equal(extractGuardAnswers({}), undefined);
  assert.equal(decideModelAdvisory(parsed).kind, "ask");
});

test("partial, non-normalized and out-of-range class distributions are rejected", () => {
  for (const probabilities of [{ medium: 0.1, high: 0.1 }, { low: 0.9, medium: 0.2, high: 0.1 }, { low: -0.1, medium: 0.5, high: 0.6 }, { low: NaN, medium: 0, high: 1 }, { low: "0.9", medium: 0.08, high: 0.02 }]) {
    const source = answers();
    source.risk.probabilities = probabilities;
    const parsed = parseModelAdvisory(source);
    assert.equal(parsed.status, "unknown");
    assert.equal(parsed.metadata.p_high, null);
  }
});

test("noul fields reject NaN, infinity, strings and range violations", () => {
  for (const noul of [NaN, Infinity, -0.01, 1.01, "0.9", undefined]) {
    assert.equal(parseModelAdvisory(answers({ irreversible: { type: "noul", noul } })).status, "unknown");
  }
});

test("confidence scales are explicit; raw provider scores are not class probabilities", () => {
  const source = answers();
  source.risk.confidence = 42;
  assert.equal(parseModelAdvisory(source).status, "valid");
  source.risk.confidenceKind = "normalized";
  assert.equal(parseModelAdvisory(source).status, "unknown");
  source.risk.confidenceKind = "arbitrary";
  assert.equal(parseModelAdvisory(source).status, "unknown");
  delete source.risk.confidenceKind;
  const unlabelled = parseModelAdvisory(source);
  assert.equal(unlabelled.metadata.confidenceKind, "unavailable");
  assert.equal(unlabelled.metadata.raw_decision_confidence, 42);
});

test("missing optional distribution stays unavailable without invented probabilities", () => {
  const source = answers();
  delete source.risk.probabilities;
  const parsed = extractGuardAnswers(source);
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.metadata.class_probabilities, "unknown");
  assert.equal(parsed.metadata.p_non_low, null);
});

test("medium/high low confidence never silently becomes allow", () => {
  for (const choice of ["medium", "high"]) {
    const source = answers();
    source.risk.choice = choice;
    source.risk.confidence = 0.01;
    assert.equal(decideModelAdvisory(parseModelAdvisory(source)).kind, "ask");
  }
});

test("high task relevance does not exempt genuine injection", () => {
  const parsed = parseModelAdvisory(answers({ matches_task: { type: "noul", noul: 1 }, injection_suspect: { type: "noul", noul: 0.99 } }));
  assert.equal(decideModelAdvisory(parsed).reasonCodes[0], "model-injection-suspect");
});

test("risk confidence does not gate low-risk task friction", () => {
  for (const confidence of [0, 0.5, 1]) {
    const source = answers({ irreversible: { type: "noul", noul: 0.9 }, matches_task: { type: "noul", noul: 0.1 } });
    source.risk.confidence = confidence;
    assert.equal(decideModelAdvisory(parseModelAdvisory(source)).kind, "ask");
  }
});
