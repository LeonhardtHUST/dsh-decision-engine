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
  assert.equal(policy("list_agents", { command: "delete" }).status, "unknown");
  assert.equal(policy("list_agents", {}, { toolAccess: "denied" }).status, "deny");
});

test("skill and inspect queries have strict read-only contracts, not broad name whitelists", () => {
  assert.equal(policy("skill", { name: "dsh-doc" }).status, "safe");
  assert.equal(policy("skill", { name: "dsh-doc", command: "fixture" }).status, "unknown");
  assert.equal(policy("skill", { name: 123 }).status, "unknown");
  assert.equal(policy("skill", { name: "dsh-doc", sandbox_permissions: "danger-full-access" }).status, "requires_approval");
  assert.equal(policy("skill", { name: "dsh-doc" }, { toolAccess: "denied" }).status, "deny");
  assert.equal(policy("cordis_inspect_list", {}).status, "safe");
  assert.equal(policy("cordis_inspect_list", { command: "fixture" }).status, "unknown");
  assert.equal(policy("cordis_inspect_query", { platform: "host", provider: "fixture", method: "schema", input: {} }).status, "safe");
  assert.equal(policy("cordis_inspect_query", { platform: "remote", provider: "fixture", method: "schema" }).status, "unknown");
  assert.equal(policy("list_subagent_models", { provider: "fixture", model: "review" }).status, "safe");
  assert.equal(policy("list_subagent_models", { provider: "fixture", command: "fixture" }).status, "unknown");
});

test("known local reads remain safe while opaque tools require uncertainty review", () => {
  assert.equal(policy("read", { file_path: "/fixture/example" }).status, "safe");
  assert.equal(policy("glob", { pattern: "**/*.js" }).status, "safe");
  assert.equal(policy("grep", { pattern: "fixture" }).status, "safe");
  assert.equal(policy("read", { file_path: "/fixture", url: "https://example.invalid" }).status, "unknown");
  assert.equal(policy("read_cloud", {}).status, "unknown");
  assert.equal(policy("mcp__unknown__read", {}).status, "unknown");
});

test("team task state and todo bookkeeping do not self-lock", () => {
  const context = { sandboxMode: "read-only", approvalAvailable: false };
  assert.equal(policy("team_task_update", { task_id: "fixture-task", expected_revision: 2, action: "complete" }, context).status, "safe");
  assert.equal(policy("todo_write", { todos: [{ content: "finish fixture", status: "completed" }] }, context).status, "safe");
  assert.equal(policy("team_task_update", { task_id: "fixture-task", expected_revision: 2, action: "execute" }, context).status, "unknown");
});

test("verified internal coordination is safe but grants no receiver permissions", () => {
  const context = { messageTarget: { membership: "same-tree", continuable: true, downstreamIndependentApproval: true, permissions: "unknown" }, hostEnforcement: { internalMessage: true } };
  const result = policy("send_message", { agent: "reviewer", message: "Review this fixture and report findings" }, context);
  assert.equal(result.status, "safe");
  assert.equal(result.effect.targetPermissions, "unknown");
  assert.equal(policy("send_message", { agent: "reviewer", message: "Review fixture" }).status, "requires_approval");
  assert.equal(policy("send_message", { agent: "reviewer", message: "Review fixture" }, { ...context, messageTarget: { ...context.messageTarget, downstreamIndependentApproval: "unknown" } }).status, "requires_approval");
});

test("network uncertainty needs review, not proof of mandatory human approval", () => {
  for (const toolName of ["web_fetch", "web_search"]) {
    const result = policy(toolName, { url: "https://example.invalid/fixture" }, { sandboxMode: "danger-full-access", approvalAvailable: false });
    assert.equal(result.status, "unknown");
    assert.equal(result.approvalAvailable, false);
  }
});

test("lexical containment is not authorization; canonical bounded workspace mutation may defer", () => {
  const args = { file_path: "fixture.txt", content: "fixture" };
  const lexical = policy("write", args, { sandboxMode: "workspace-write" }, { kind: "none", canonical: "unknown" });
  assert.equal(lexical.status, "unknown");
  assert.equal(policy("write", args, { sandboxMode: "workspace-write", fileTargetScope: "inside" }).status, "safe");
  assert.equal(policy("write", args, { sandboxMode: "danger-full-access", fileTargetScope: "outside" }).status, "requires_approval");
  assert.equal(policy("write", args, { sandboxMode: "read-only", fileTargetScope: "inside" }).status, "requires_approval");
  assert.equal(policy("write", { ...args, sandbox_permissions: "danger-full-access" }, { sandboxMode: "danger-full-access" }).status, "requires_approval");
});

test("patch mutations preserve read-only and outside boundaries without trusting lexical inside", () => {
  for (const field of ["input", "patch"]) {
    const args = { [field]: "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-fixture\n+patched\n*** End Patch" };
    assert.equal(policy("apply_patch", args, { sandboxMode: "workspace-write" }, { kind: "none", canonical: "unknown" }).status, "unknown");
    assert.equal(policy("apply_patch", args, { sandboxMode: "read-only" }, { kind: "none", canonical: "unknown" }).status, "requires_approval");
    assert.equal(policy("apply_patch", args, { sandboxMode: "danger-full-access" }, { kind: "outside-workspace", canonical: "unknown" }).status, "requires_approval");
  }
});

test("opaque shells and encoded scripts stay unknown regardless confidence or full access", () => {
  for (const command of ["node -e 'process.exit()'", "python fixture.py", "pwsh -EncodedCommand Zml4dHVyZQ==", "alias-command", "echo fixture", "curl https://example.invalid"]) {
    const result = policy("pwsh", { command }, { sandboxMode: "danger-full-access", approvalAvailable: false, confidence: 0.999 });
    assert.equal(result.status, "unknown", command);
  }
});

test("proven destructive and privileged effects remain mandatory across confidence levels", () => {
  for (const command of ["rm /fixture/file", "Remove-Item fixture.txt", "sudo fixture", "Set-Acl fixture.txt"]) {
    const result = policy("pwsh", { command }, { sandboxMode: "danger-full-access", approvalAvailable: false, confidence: 0.999 });
    assert.equal(result.status, "requires_approval", command);
  }
});

test("highImpact uncertainty alone is not evidence of an approval requirement", () => {
  const result = evaluateMandatoryPolicy({ context: { approvalAvailable: false }, effect: { kind: "unknown", highImpact: true } });
  assert.equal(result.status, "unknown");
  assert.equal(result.approvalAvailable, false);
});

test("unavailable low-impact effect stays unknown without guessing authorization", () => {
  const result = evaluateMandatoryPolicy({ context: {}, effect: { kind: "unknown", highImpact: false } });
  assert.equal(result.status, "unknown");
  assert.equal(result.approvalAvailable, "unknown");
});
