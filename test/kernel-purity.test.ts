import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Iteration 2 of the 2026-10-04 campaign (change-type: gate).
 *
 * AGENTS.md states the kernel layer (`src/kernel/`) "can never depend on a
 * host surface" - no LLM, IO, UI, or SDK imports. The whole trust argument
 * (deterministic authority, pure contracts, fail-closed) rests on that rule,
 * but nothing enforced it: a `node:fs` or SDK import added later would pass
 * lint, typecheck, and every focused suite silently.
 *
 * This gate closes the *import-graph* half of the rule: every module
 * specifier under `src/kernel/` must be relative AND resolve to a path inside
 * `src/kernel/` (a bare `node:*`/SDK specifier, or a relative `../` traversal
 * into a host-facing layer such as `../application/`, both fail). It is
 * purely offline and deterministic.
 *
 * Bounded claim: it does NOT catch import-free ambient IO (`fetch(...)`,
 * `process.env`, `Date.now`, `Math.random`), which is a separate class that
 * needs a different scan; this test is exact about the half it covers.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const kernelDir = join(repoRoot, "src", "kernel");

function kernelModules(dir = kernelDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...kernelModules(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strip line and block comments so a comment mentioning `from "node:fs"` is
 * not mistaken for a real specifier. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Extract string specifiers from `import/export ... from "x"`, `import "x"`,
 * dynamic `import("x")`, and `require("x")`. Type-only imports are included
 * on purpose: `import type { X } from "y"` still couples the kernel to `y`
 * at the type layer.
 */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import/export ... from "x"
    /\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

test("kernel purity: src/kernel modules import only from within src/kernel", () => {
  const modules = kernelModules();
  assert.ok(modules.length > 0, "expected at least one src/kernel module");
  const violations: string[] = [];
  for (const module of modules) {
    const source = stripComments(readFileSync(module, "utf8"));
    for (const specifier of moduleSpecifiers(source)) {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      // A relative specifier must resolve back inside src/kernel; anything
      // else (bare `node:*`/package, or a `../` traversal into a host layer)
      // is a purity violation.
      const resolved = isRelative ? resolve(dirname(module), specifier) : undefined;
      const insideKernel = resolved !== undefined && !relative(kernelDir, resolved).startsWith("..");
      if (!isRelative || !insideKernel) {
        violations.push(`${relative(repoRoot, module)}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `kernel purity violated - src/kernel may depend only on itself (relative, in-tree specifiers):\n${violations.join("\n")}`,
  );
});
