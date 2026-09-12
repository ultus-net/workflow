import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function createRepository(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "git-intelligence-fixture-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Fixture Author"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  writeFileSync(join(root, "rename-me.txt"), "rename\n");
  git(root, ["add", "."]);
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function createDirectory(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "git-intelligence-directory-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function makeDirectory(root: string, path: string): void {
  mkdirSync(join(root, path), { recursive: true });
}
