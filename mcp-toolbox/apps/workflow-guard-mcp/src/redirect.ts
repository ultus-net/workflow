/**
 * W070b slice 4a: deterministic deny-with-redirect text.
 *
 * Open models drift on prose guidance, so a denial stays minimal and
 * mechanical: the short reason names the violated precondition, and this
 * redirect names the expected tool class so the model satisfies the
 * precondition directly instead of retrying with shell variants.
 *
 * This is denial UX, not enforcement — the decision itself is already
 * deterministic; the redirect only tells the model what to do next.
 */

const REDIRECTS: Readonly<Record<string, string>> = {
  "workspace-boundary": "Expected: a file-write tool (edit/write/apply_patch) with a path inside the workspace root.",
  "protected-path": "Expected: a file-write tool targeting an allowed source path, not a protected or secret path.",
  "protected-shell-path": "Expected: a file-write tool on an in-workspace source path; do not mutate the protected path.",
  "secret-content": "Expected: a file-write tool without credentials in the content; supply secrets through credential custody.",
  "secret-source-transfer": "Expected: credential custody, not a file copy/link that launders the secret path.",
  "guard-tamper": "Expected: guard_status (read) for policy state; do not modify guard or host configuration.",
  "read-only-role": "Expected: read-class tools (read/fs/read_text_file); this role has no mutation capability.",
  "protected-branch-write": "Expected: create or switch to a feature branch (git checkout -b), then retry the file write.",
  "protected-branch-push": "Expected: push to a feature branch, or open a PR; direct pushes to protected branches are not allowed.",
  "unsafe-git-alias": "Expected: a plain git command without inline aliases.",
  "destructive-operation": "Expected: a direct tool call (edit/write/apply_patch/delete_file) with a concrete target, not shell indirection.",
  "package-hygiene": "Expected: the package manager's lockfile command; do not delete or rewrite lockfiles by hand.",
  "dynamic-shell-syntax": "Expected: a concrete, inspectable command or a dedicated tool; avoid generated shell syntax.",
  "interpreter-secret-path": "Expected: credential custody; do not reference protected paths from an interpreter payload.",
  "interpreter-protected-write": "Expected: a file-write tool on an allowed in-workspace path.",
  "live-mcp-mutation": "Expected: a non-mutating MCP read tool; live-system mutations require explicit operator action.",
  "pr-create-literal-escapes": "Expected: gh pr create with a body file or real newlines, not literal \\n escapes.",
  "invalid-hook-event": "Expected: a PreToolUse hook event.",
  "unsupported-tool-input": "Expected: a supported guarded tool input with its required fields.",
  "invalid-hook-input": "Expected: a well-formed hook input.",
};

export const DEFAULT_REDIRECT =
  "Expected: use the tool class the policy names directly; do not retry with alternate shell forms.";

export function redirectGuidance(policy: string): string {
  return REDIRECTS[policy] ?? DEFAULT_REDIRECT;
}
