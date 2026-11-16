import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolEffect } from "../lib/guard/effects.js";
import { evaluateMandatoryPolicy } from "../lib/guard/policy.js";

const freshPowerShell = { shellExecution: { freshProcess: true, noProfile: true } };

function classify(toolName, args, trustedContext = {}) {
  return classifyToolEffect({ toolName, args, trustedContext });
}

const internalFixtures = [
  ["team_task_create", { subject: "fixture", description: "isolated bookkeeping", blocked_by: ["fixture-task"], write_scopes: ["fixture/"] }],
  ["wait_agent", {}],
  ["wait_agent", { timeout_ms: 10_000 }],
  ["wait_agent", { timeout_ms: 3_600_000 }],
  ["interrupt_agent", { agent: "fixture-child" }],
  ["job_kill", { job_id: "fixture-job", reason: "fixture only" }],
  ["ask_user_question", { questions: [{ id: "fixture", question: "Choose fixture?", header: "Fixture", options: [{ label: "yes", description: "fixture" }], multi_select: false }] }],
  ["create_goal", { objective: "fixture goal", max_goal_rounds: 2 }],
  ...["pause", "resume", "complete"].map((action) => ["update_goal", { goal_id: "fixture-goal", revision: 1, action }]),
  ["update_goal", { goal_id: "fixture-goal", revision: 1, action: "edit", objective: "new fixture", max_goal_rounds: 0 }],
  ["update_goal", { goal_id: "fixture-goal", revision: 1, action: "blocked", blocked_reason: "fixture condition" }],
];

test("strict internal contracts defer only bounded state operations to host enforcement", () => {
  for (const [toolName, args] of internalFixtures) {
    const effect = classify(toolName, args);
    assert.equal(effect.kind, "internal_state", toolName);
    assert.equal(effect.known, true, toolName);
    assert.equal(effect.highImpact, false, toolName);
    assert.equal(effect.hostEnforced, true, toolName);
    assert.equal(evaluateMandatoryPolicy({ context: { sandboxMode: "read-only", approvalAvailable: false }, effect }).status, "safe", toolName);
    assert.equal(evaluateMandatoryPolicy({ context: { toolAccess: "denied" }, effect }).status, "deny", toolName);
    assert.equal(classify(toolName, { ...args, command: "fixture" }).known, false, toolName);
    assert.equal(classify(toolName, { ...args, sandbox_permissions: "danger-full-access" }).kind, "privileged", toolName);
  }
});

test("malformed internal arguments fail closed including nested question schemas", () => {
  const fixtures = [
    ["team_task_create", {}],
    ["team_task_create", { subject: "fixture", description: "fixture", blocked_by: "fixture" }],
    ["team_task_create", { subject: "fixture", description: "fixture", write_scopes: [42] }],
    ["team_task_update", { task_id: "fixture", expected_revision: 1, action: "edit", description: {} }],
    ["wait_agent", { timeout_ms: 9999 }],
    ["wait_agent", { timeout_ms: 3_600_001 }],
    ["wait_agent", { timeout_ms: 10_000.5 }],
    ["wait_agent", { timeout_ms: Infinity }],
    ["wait_agent", { timeout_ms: "10000" }],
    ["interrupt_agent", { agent: "" }],
    ["interrupt_agent", { agent: 42 }],
    ["job_kill", { job_id: "fixture", reason: {} }],
    ["job_kill", { job_id: "" }],
    ["ask_user_question", { questions: [] }],
    ["ask_user_question", { questions: [{ id: "fixture", question: 42 }] }],
    ["ask_user_question", { questions: [{ id: "fixture", question: "fixture", options: [{ label: "fixture", command: "fixture" }] }] }],
    ["ask_user_question", { questions: [{ id: "fixture", question: "fixture", multi_select: "true" }] }],
    ["create_goal", { objective: "fixture", max_goal_rounds: 0 }],
    ["create_goal", { objective: "fixture", max_goal_rounds: NaN }],
    ["update_goal", { goal_id: "fixture", revision: 0, action: "complete" }],
    ["update_goal", { goal_id: "fixture", revision: 1, action: "execute" }],
    ["update_goal", { goal_id: "fixture", revision: 1, action: "edit" }],
    ["update_goal", { goal_id: "fixture", revision: 1, action: "blocked", blocked_reason: " " }],
    ["update_goal", { goal_id: "fixture", revision: 1, action: "complete", objective: {} }],
  ];
  for (const [toolName, args] of fixtures) {
    const effect = classify(toolName, args);
    assert.equal(effect.known, false, toolName);
    assert.equal(effect.highImpact, true, toolName);
  }
});

test("undo history contracts cover only exact read schemas, never mutation name families", () => {
  for (const [toolName, args] of [["undo_list", {}], ["undo_message_list", {}], ["undo_diff", { snapshot_id: "fixture-snapshot" }]]) {
    const effect = classify(toolName, args);
    assert.equal(effect.kind, "read_local");
    assert.equal(effect.recoverability, "no-mutation");
    assert.equal(evaluateMandatoryPolicy({ effect }).status, "safe");
    assert.equal(classify(toolName, { ...args, fix: true }).known, false);
  }
  for (const [toolName, args] of [
    ["undo_diff", {}], ["undo_diff", { snapshot_id: 42 }],
    ["undo_restore", { mode: "undo" }], ["undo_snapshot", {}], ["undo_message", {}],
    ["undo_prune", {}], ["undo_doctor", { fix: true }], ["undo_safe_mode", { action: "on" }],
    ["message_list", {}], ["plugin_manager", { action: "enable", name: "fixture" }],
    ["present", { files: [{ path: "fixture.txt" }] }],
  ]) {
    const effect = classify(toolName, args);
    assert.equal(effect.known, false, toolName);
    assert.equal(effect.highImpact, true, toolName);
  }
});

test("PowerShell read closure accepts only canonical single commands and closed parameters", () => {
  for (const command of [
    "Get-Location", "Get-Date -AsUTC", "Get-Process", "Get-Process -Id 42", "Get-Process -Name fixture",
    "Get-ChildItem -Force", "Get-ChildItem -LiteralPath './fixture dir' -File -Name",
    "Get-Item fixture.txt", "Get-Content -LiteralPath fixture.txt -TotalCount 20",
    'Get-Content "fixture dir/fixture.txt" -Raw', "Test-Path -LiteralPath fixture.txt",
  ]) {
    const effect = classify("pwsh", { command, description: "fixture classification only", timeoutMs: 1000, run_in_background: false }, freshPowerShell);
    assert.equal(effect.kind, "read_local", command);
    assert.equal(effect.known, true, command);
    assert.equal(effect.highImpact, false, command);
    assert.deepEqual(effect.reasonCodes, ["known-read-only-powershell-command"]);
    assert.equal(evaluateMandatoryPolicy({ effect }).status, "safe", command);
  }
});

test("a command name cannot attest a clean shell or rule out persistent function overrides", () => {
  for (const trustedContext of [{}, { hostEnforcement: { shell: true } },
    { shellExecution: { freshProcess: false, noProfile: true } },
    { shellExecution: { freshProcess: true, noProfile: false } },
    { shellExecution: { freshProcess: "true", noProfile: true } }]) {
    const effect = classify("pwsh", { command: "Get-Location" }, trustedContext);
    assert.equal(effect.known, false);
    assert.equal(effect.highImpact, true);
    assert.deepEqual(effect.reasonCodes, ["unparsed-high-impact-execution"]);
  }
  assert.equal(classify("pwsh", { command: "Get-Location", shellExecution: freshPowerShell.shellExecution }).known, false);
});

test("shell operators, execution, network, providers and non-closed flags never gain read authorization", () => {
  const commands = [
    "Get-Location | Out-File fixture.txt", "Get-Location > fixture.txt", "Get-Location 2>&1",
    "Get-Location; Remove-Item fixture.txt", "Get-Location && fixture", "Get-Location\nfixture",
    "Get-Content $(fixture)", "Get-Content `fixture`", "Get-Content $env:FIXTURE",
    "& Get-Location", ". fixture.ps1", "pwsh -Command Get-Location", "pwsh -EncodedCommand Zml4dHVyZQ==",
    "node -e fixture", "python fixture.py", "curl https://example.invalid", "Invoke-WebRequest https://example.invalid",
    "Get-Item https://example.invalid", "Get-Item \\\\fixture-host\\share", "Get-Item //fixture-host/share",
    "Get-Item env:FIXTURE", "Get-Item C:\\fixture", "Get-Item ../fixture", "Get-Item .\\..\\fixture",
    "Get-Content fixture.txt -Wait", "Get-ChildItem -OutVariable fixture", "Get-Process -FileVersionInfo",
    "Get-ChildItem -Unknown", "Get-Content -Path fixture.txt", "Get-Content fixture.txt -Tail 1 -Tail 2",
    "Get-Item 'fixture.txt'junk", "Get-Item 'fixture.txt", "Get-Item fixture,other",
    "Get-Location # fixture", "Get-Location\u0000", "Get-Location\u2028fixture",
    "Get-Location -Verbose", "'Get-Location'", "get-location.exe", "ls", "echo fixture", "git status",
    "__proto__", "constructor", "toString",
  ];
  for (const command of commands) {
    const effect = classify("pwsh", { command }, freshPowerShell);
    assert.notEqual(effect.kind, "read_local", command);
    assert.equal(effect.highImpact, true, command);
    assert.notEqual(evaluateMandatoryPolicy({ effect }).status, "safe", command);
  }
  for (const args of [
    { command: "Get-Location", unknown: true }, { command: "Get-Location", run_in_background: true },
    { command: "Get-Location", timeoutMs: Infinity }, { command: "Get-Location", timeoutMs: "1000" },
    { command: "Get-Location", workdir: "\\\\fixture-host\\share" },
    { command: "Get-Location", sandbox_permissions: "danger-full-access" },
  ]) assert.notEqual(classify("pwsh", args, freshPowerShell).kind, "read_local");
  for (const toolName of ["bash", "shell"]) assert.equal(classify(toolName, { command: "Get-Location" }).known, false);
});

test("shell hazard reason codes retain precedence over any read closure", () => {
  for (const [command, kind, reason] of [
    ["Get-Location; sudo fixture", "privileged", "possible-shell-privilege-change"],
    ["Get-Location; Remove-Item fixture.txt", "destructive", "possible-shell-destructive-effect"],
    ["Get-Location; curl https://example.invalid", "external_network", "possible-shell-external-effect"],
    ["opaque-fixture", "unknown", "unparsed-high-impact-execution"],
  ]) {
    const effect = classify("pwsh", { command }, freshPowerShell);
    assert.equal(effect.kind, kind);
    assert.deepEqual(effect.reasonCodes, [reason]);
  }
});
