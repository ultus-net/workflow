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

/**
 * Iteration 2 of campaign 2 (change-type: gate) — the import-free ambient-IO
 * half the W186 test above explicitly excludes.
 *
 * The import gate cannot catch IO reached WITHOUT an import: the ambient
 * globals `Date`, `Math.random`, `fetch`, `process`, timers, `crypto`,
 * `performance`, `globalThis`, the host globals, `console`, and `Buffer` are
 * all reachable with no module specifier, so a future `Date.now()` or
 * `process.env` read in the kernel would pass lint, typecheck, and every
 * focused suite while breaking determinism (the property the kernel's whole
 * trust argument rests on).
 *
 * A single-pass lexer blanks comments and the literal text of strings and
 * templates (so a comment or message mentioning a token does not trip it) but
 * re-emits executable code, including inside template `${...}` interpolation
 * bodies (a `${Date.now()}` must not hide, EXCEPT when a regex literal is
 * involved; see the bounded claim below). Blanked regions emit a separator
 * (space), never nothing, so two tokens cannot fuse across a removed comment
 * (e.g. a block comment between `await` and `fetch` still leaves a boundary).
 * Token-bounded patterns
 * (`\bDate\b`, `Math\.random`) keep the pure `Math.max`/`Math.min` legal.
 * Purely offline and deterministic.
 *
 * Bounded claim: this is the high-value named class, not every conceivable
 * host coupling. Not modelled: regex LITERALS. A regular expression can be
 * mis-read by this lexer — a slash, quote, or backtick inside a regex opens
 * the comment/string/template branch, and a brace inside a regex in a `${...}`
 * body can close the interpolation early — which can either false-trip
 * (`/Date/`) or blank executable code that follows. The `${...}`-cannot-hide
 * guarantee therefore holds ONLY for inputs without regex literals. If a regex
 * literal is ever added under `src/kernel/`, this scanner needs regex-literal
 * state. Also not modelled: `new Function`, `Intl`, and `Math` reached other
 * than by a dot (`Math?.random()`, `Math["random"]()`,
 * `const { random } = Math`) — plain `Math.max`/`Math.min` stay legal.
 * Indirect reach through a relative import is the OTHER gate's job.
 * Conservative by design: an identifier or member whose NAME is an ambient
 * token (`obj.window`, an interface field `crypto`) matches.
 */
function scanAmbient(source: string): string {
  // A tiny lexer: blanks comment/string/template-literal text (emitting a
  // separator so token boundaries survive and newlines so line numbers stay
  // exact), while re-emitting executable code. Template `${...}` bodies are
  // lexed recursively, so a string or nested brace inside the interpolation
  // cannot hide or falsely expose a token. `expr` mode adds brace-depth
  // tracking so the interpolation ends at its matching `}`.
  let i = 0;
  const n = source.length;
  let out = "";

  function lex(mode: "top" | "expr"): void {
    let depth = 1; // only meaningful in expr mode
    while (i < n) {
      const ch = source[i]!;
      if (mode === "expr") {
        if (ch === "}") {
          depth--;
          if (depth === 0) return; // leave i on the closing brace
          out += ch;
          i++;
          continue;
        }
        if (ch === "{") {
          depth++;
          out += ch;
          i++;
          continue;
        }
      }
      if (ch === "/" && source[i + 1] === "/") {
        i += 2;
        while (i < n && source[i] !== "\n") i++;
        out += " ";
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        out += " ";
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
          if (source[i] === "\n") out += "\n";
          i++;
        }
        i += 2;
        out += " ";
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        out += " ";
        while (i < n && source[i] !== quote) {
          if (source[i] === "\\") {
            if (source[i + 1] === "\n") out += "\n";
            i += 2;
            continue;
          }
          if (source[i] === "\n") {
            out += "\n";
            i++;
            break;
          }
          i++;
        }
        if (source[i] === quote) i++;
        out += " ";
        continue;
      }
      if (ch === "`") {
        i++;
        out += " ";
        while (i < n && source[i] !== "`") {
          if (source[i] === "\\") {
            if (source[i + 1] === "\n") out += "\n";
            i += 2;
            continue;
          }
          if (source[i] === "$" && source[i + 1] === "{") {
            i += 2;
            out += " ";
            lex("expr");
            if (source[i] === "}") i++;
            out += " ";
            continue;
          }
          if (source[i] === "\n") out += "\n";
          i++;
        }
        if (source[i] === "`") i++;
        out += " ";
        continue;
      }
      out += ch;
      i++;
    }
  }

  lex("top");
  return out;
}

test("kernel purity: src/kernel does not reach ambient host globals", () => {
  // Each pattern is token-bounded so substrings (`update`, `Math.max`) do not
  // match. `Math.random` is listed specifically because `Math` itself is pure.
  const ambient: [string, RegExp][] = [
    ["Date", /\bDate\b/],
    ["Math.random", /\bMath\s*\.\s*random\b/],
    ["fetch", /\bfetch\b/],
    ["process", /\bprocess\b/],
    ["require", /\brequire\b/],
    ["eval", /\beval\b/],
    ["setTimeout", /\bsetTimeout\b/],
    ["setInterval", /\bsetInterval\b/],
    ["setImmediate", /\bsetImmediate\b/],
    ["queueMicrotask", /\bqueueMicrotask\b/],
    ["requestAnimationFrame", /\brequestAnimationFrame\b/],
    ["crypto", /\bcrypto\b/],
    ["performance", /\bperformance\b/],
    ["globalThis", /\bglobalThis\b/],
    ["navigator", /\bnavigator\b/],
    ["localStorage", /\blocalStorage\b/],
    ["sessionStorage", /\bsessionStorage\b/],
    ["indexedDB", /\bindexedDB\b/],
    ["WebSocket", /\bWebSocket\b/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["window", /\bwindow\b/],
    ["document", /\bdocument\b/],
    ["console", /\bconsole\b/],
    ["Buffer", /\bBuffer\b/],
  ];

  const violations: string[] = [];
  for (const module of kernelModules()) {
    const lines = scanAmbient(readFileSync(module, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const [name, pattern] of ambient) {
        if (pattern.test(line)) violations.push(`${relative(repoRoot, module)}:${index + 1}: ${name}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `kernel purity violated - src/kernel must not reach ambient host globals:\n${violations.join("\n")}`,
  );
});

