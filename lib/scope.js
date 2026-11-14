import { posix, win32 } from "node:path";

export const SCOPE_KINDS = Object.freeze({
  outsideWorkspace: "outside-workspace",
  awaitingUser: "awaiting-user",
  unknown: "unknown",
});
export const SCOPE_NONE = "none";

function pathApi(value) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? win32 : posix;
}

function absolutePath(value, cwd) {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n$`*?]|^~|^[A-Za-z]:[^\\/]/.test(value)) return undefined;
  const api = pathApi(value);
  if (api.isAbsolute(value)) return { path: api.normalize(value), api };
  if (typeof cwd !== "string" || !pathApi(cwd).isAbsolute(cwd)) return undefined;
  const baseApi = pathApi(cwd);
  return { path: baseApi.resolve(cwd, value), api: baseApi };
}

export function isUnderRoots(target, roots, cwd) {
  const resolved = absolutePath(target, cwd);
  if (!resolved || !Array.isArray(roots) || !roots.length) return true;
  return roots.some((root) => {
    const base = absolutePath(root, cwd);
    if (!base || base.api !== resolved.api) return false;
    const relative = resolved.api.relative(base.path, resolved.path);
    return relative === "" || (!relative.startsWith(`..${resolved.api.sep}`) && relative !== ".." && !resolved.api.isAbsolute(relative));
  });
}

export function pathTargetsOf(tool, args) {
  if (!args || typeof args !== "object") return [];
  if (tool === "apply_patch") {
    const patch = args.input ?? args.patch;
    if (typeof patch !== "string") return [];
    return [...patch.matchAll(/^\*\*\* (?:(?:Update|Add|Delete|Move) File|Move to): (.+)$/gm)]
      .map((match) => match[1].trim()).filter(Boolean);
  }
  return [args.file_path, args.path, args.file, args.destination, args.new_path]
    .filter((value) => typeof value === "string" && value.length > 0);
}

export function pathTargetOf(tool, args) {
  return pathTargetsOf(tool, args)[0];
}

export function classifyWorkspaceTarget(options) {
  const targets = pathTargetsOf(options.tool, options.args);
  const roots = options.roots;
  if (!targets.length || !Array.isArray(roots) || !roots.length || roots.some((root) => !absolutePath(root, options.cwd))) {
    return { kind: SCOPE_KINDS.unknown, targets, coverage: "unknown", canonical: "unknown" };
  }
  const resolved = targets.map((target) => absolutePath(target, options.cwd));
  if (resolved.some((target) => !target)) {
    return { kind: SCOPE_KINDS.unknown, targets, coverage: "partial", canonical: "unknown" };
  }
  const outside = targets.filter((target) => !isUnderRoots(target, roots, options.cwd));
  return {
    kind: outside.length ? SCOPE_KINDS.outsideWorkspace : SCOPE_NONE,
    targets,
    outside,
    coverage: "lexical-only",
    canonical: "unknown",
  };
}
