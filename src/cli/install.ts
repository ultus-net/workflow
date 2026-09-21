import { installFleet, parseInstallArgs } from "../integrations/fleet-payload.js";

/**
 * W086 — `workflow install fleet`: the operator-invoked deployment of the
 * vendored fleet payload (agents/commands into the host config dir, docs
 * install-if-missing into the workspace repo). The explicit command IS the
 * ask-gate — nothing here runs unattended, and the installer never touches
 * the host config document (the permission surface).
 */
export async function runInstall(rest: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(rest);
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    return 1;
  }
  const results = installFleet({ force: parsed.force });
  const marks: Record<string, string> = {
    written: "+",
    "already-current": "=",
    "skipped-local-modified": "!",
    "skipped-repo-doc": "!",
    forced: "+",
  };
  for (const result of results) {
    console.log(`  ${marks[result.action] ?? "?"} ${result.action.padEnd(22)} ${result.entry.id} -> ${result.target}`);
  }
  const skippedModified = results.filter((result) => result.action === "skipped-local-modified");
  const skippedDocs = results.filter((result) => result.action === "skipped-repo-doc");
  if (skippedModified.length > 0) {
    console.error(
      `\n${skippedModified.length} agent/command file(s) differ locally and were NOT overwritten. ` +
        "Rerun with --force only if those local edits are disposable.",
    );
  }
  if (skippedDocs.length > 0) {
    console.error(
      `\n${skippedDocs.length} repo doc(s) differ and were never overwritten — docs are repo-owned living files; reconcile them by hand.`,
    );
  }
  return skippedModified.length > 0 ? 1 : 0;
}
