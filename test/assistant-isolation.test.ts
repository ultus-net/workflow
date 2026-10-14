import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Import-graph gate for the folded augur assistant (parallel to
 * `kernel-purity.test.ts`). The assistant is an isolated subtree under
 * `src/assistant/` plus one CLI entry (`src/cli/augur.ts`). The plane must
 * NOT depend on the assistant: the assistant is a client that mounts the
 * plane, never the other way round. Keeping the dependency arrow one-way
 * preserves the removability invariant (the plane runs green with the
 * assistant absent).
 *
 * Bounded claim: this is the reach-through that matters (a plane module
 * importing assistant code). It is a relative-specifier check, string-aware
 * around comments and string/template literals, with the same regex-literal
 * caveat the kernel gate documents. Bare package specifiers are out of scope.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(repoRoot, "src");
const assistantDir = join(srcDir, "assistant");
/** The single sanctioned bridge: the assistant's own CLI entry. */
const assistantEntry = join(srcDir, "cli", "augur.ts");

function srcModules(dir = srcDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...srcModules(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Blank line comments and block comments, preserving line structure. */
function blankComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let mode: "top" | "line" | "block" | "string" | "template" = "top";
  let quote = "";
  while (i < n) {
    const ch = source[i]!;
    if (mode === "line") {
      if (ch === "\n") {
        mode = "top";
        out += "\n";
      } else {
        out += " ";
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && source[i + 1] === "/") {
        mode = "top";
        out += "  ";
        i += 2;
      } else {
        out += ch === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (mode === "string" || mode === "template") {
      const closer = mode === "string" ? quote : "`";
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === closer) mode = "top";
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      mode = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      mode = "block";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      mode = "string";
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      mode = "template";
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

test("assistant isolation: only the assistant CLI entry imports src/assistant", () => {
  const violations: string[] = [];
  for (const module of srcModules()) {
    const inAssistant = !relative(assistantDir, module).startsWith("..");
    if (inAssistant || module === assistantEntry) continue;
    const source = blankComments(readFileSync(module, "utf8"));
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const resolved = resolve(dirname(module), specifier);
      const reachesAssistant = relative(assistantDir, resolved).startsWith("..") === false;
      if (reachesAssistant) {
        violations.push(`${relative(repoRoot, module)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `assistant isolation violated - the plane must not import src/assistant (only src/cli/augur.ts may):\n${violations.join("\n")}`,
  );
});
