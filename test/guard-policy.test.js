import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolEffect } from "../lib/guard/effects.js";
import { evaluateMandatoryPolicy } from "../lib/guard/policy.js";

function policy(toolName, args, context = {}, scope) {
  const effect = classifyToolEffect({ toolName, args, trustedContext: context, scope });
  return { effect, ...evaluateMandatoryPolicy({ context, effect }) };
}

test("strict list_agents empty query is safe even with unknown context", () => {
  assert.equal(policy("list_agents", {}).status, "safe");
  assert.equal(policy("list_agents", { command: "delete" }).status, "requires_approval");
  assert.equal(policy("list_agents", {}, { toolAccess: "denied" }).status, "deny");
});

test("known local reads remain safe but unknown tools and arbitrary MCP reads do not", () => {
  assert.equal(policy("read", { file_path: "/fixture/example" }).status, "safe");
  assert.equal(policy("glob", { pattern: "**/*.js" }).status, "safe");
  assert.equal(policy("grep", { pattern: "fixture" }).status, "safe");
  assert.equal(policy("read", { file_path: "/fixture", url: "https://example.invalid" }).status, "requires_approval");
  assert.equal(policy("read_cloud", {}).status, "requires_approval");
  assert.equal(policy("mcp__unknown__read", {}).status, "requires_approval");
});

test("team task state and todo bookkeeping do not self-lock", () => {
  const context = { sandboxMode: "read-only", approvalAvailable: false };
  assert.equal(policy("team_task_update", { task_id: "fixture-task", expected_revision: 2, action: "complete" }, context).status, "safe");
  assert.equal(policy("todo_write", { todos: [{ content: "finish fixture", status: "completed" }] }, context).status, "safe");
  assert.equal(policy("team_task_update", { task_id: "fixture-task", expected_revision: 2, action: "execute" }, context).status, "requires_approval");
});

test("verified internal coordination is safe but grants no receiver permissions", () => {
  const context = { messageTarget: { membership: "same-tree", continuable: true, downstreamIndependentApproval: true, permissions: "unknown" }, hostEnforcement: { internalMessage: true } };
  const result = policy("send_message", { agent: "reviewer", message: "Review this fixture and report findings" }, context);
  assert.equal(result.status, "safe");
  assert.equal(result.effect.targetPermissions, "unknown");
  assert.equal(policy("send_message", { agent: "reviewer", message: "Review fixture" }).status, "requires_approval");
  assert.equal(policy("send_message", { agent: "reviewer", message: "Review fixture" }, { ...context, messageTarget: { ...context.messageTarget, downstreamIndependentApproval: "unknown" } }).status, "requires_approval");
});

test("external effects are approval-bound, not read-only whitelist", () => {
  for (const toolName of ["web_fetch", "web_search"]) {
    const result = policy(toolName, { url: "https://example.invalid/fixture" }, { sandboxMode: "danger-full-access", approvalAvailable: false });
    assert.equal(result.status, "requires_approval");
    assert.equal(result.approvalAvailable, false);
  }
});

test("lexical containment is not authorization; canonical bounded workspace mutation may defer", () => {
  const args = { file_path: "fixture.txt", content: "fixture" };
  const lexical = policy("write", args, { sandboxMode: "workspace-write" }, { kind: "none", canonical: "unknown" });
  assert.equal(lexical.status, "requires_approval");
  assert.equal(policy("write", args, { sandboxMode: "workspace-write", fileTargetScope: "inside" }).status, "safe");
  assert.equal(policy("write", args, { sandboxMode: "danger-full-access", fileTargetScope: "outside" }).status, "requires_approval");
  assert.equal(policy("write", args, { sandboxMode: "read-only", fileTargetScope: "inside" }).status, "requires_approval");
  assert.equal(policy("write", { ...args, sandbox_permissions: "danger-full-access" }, { sandboxMode: "danger-full-access" }).status, "requires_approval");
});

test("unknown shells and encoded scripts stay approval-bound regardless confidence or full access", () => {
  for (const command of ["node -e 'process.exit()'", "python fixture.py", "pwsh -EncodedCommand Zml4dHVyZQ==", "alias-command", "echo fixture", "rm /fixture/file", "Remove-Item fixture.txt", "sudo fixture", "curl https://example.invalid"]) {
    const result = policy("pwsh", { command }, { sandboxMode: "danger-full-access", approvalAvailable: false, confidence: 0.999 });
    assert.equal(result.status, "requires_approval", command);
  }
});

test("unavailable low-impact effect stays unknown without guessing authorization", () => {
  const result = evaluateMandatoryPolicy({ context: {}, effect: { kind: "unknown", highImpact: false } });
  assert.equal(result.status, "unknown");
  assert.equal(result.approvalAvailable, "unknown");
});
