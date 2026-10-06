import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Iteration 1 of campaign 3 (change-type: gate) — the shared, string-aware
 * lexer.
 *
 * This file carries TWO kernel-purity gates: the import-graph gate (W186) and
 * the ambient-host-global gate (W189). Both must strip comments so a comment
 * that merely mentions `from "node:fs"` or `Date.now()` is not treated as
 * code. The import gate previously used a regex `stripComments` that blanks
 * `/*` and `//` regardless of context, so a `//` or `/*` INSIDE a string or
 * template literal would blank the rest of the line/block — including a real
 * specifier — and could silently hide an import violation (or, on the ambient
 * side, hide a global). The ambient gate already had a single-pass lexer that
 * understands strings and templates; this iteration factors that lexer into
 * one shared `lexBlank` and routes the import gate through it, so:
 *
 *   - the import gate strips comments ONLY (string/template text is preserved,
 *     because module specifiers live in strings);
 *   - the ambient gate strips comments AND string/template text (so a string
 *     containing the word `Date` does not trip it);
 *   - both inherit the SAME bounded regex-literal caveat instead of drifting.
 *
 * Purely offline and deterministic.
 *
 * Bounded claim (shared by both gates): this is the high-value named class,
 * not every conceivable host coupling. Not modelled: regex LITERALS. A
 * regular expression can be mis-read by this lexer — a slash, quote, or
 * backtick inside a regex opens the comment/string/template branch, and a
 * brace inside a regex in a `${...}` body can close the interpolation early —
 * which can either false-trip (`/Date/`) or blank executable code that
 * follows. The `${...}`-cannot-hide guarantee therefore holds ONLY for inputs
 * without regex literals. If a regex literal is ever added under
 * `src/kernel/`, this lexer needs regex-literal state. Also not modelled:
 * `new Function`, `Intl`, and `Math` reached other than by a dot
 * (`Math?.random()`, `Math["random"]()`, `const { random } = Math`) — plain
 * `Math.max`/`Math.min` stay legal. Indirect reach through a relative import
 * is the import gate's job. Conservative by design: an identifier or member
 * whose NAME is an ambient token (`obj.window`, an interface field `crypto`)
 * matches the ambient gate.
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

/**
 * The one shared lexer. Walks `source` once, blanking comments (to a space,
 * preserving newlines so line numbers stay exact), and — when `blankStrings`
 * is true — also blanking the literal text of strings and templates. Template
 * `${...}` interpolation bodies are always lexed as CODE (recursively), so a
 * `${Date.now()}` cannot hide behind a template, and a string or nested brace
 * inside the interpolation cannot hide or falsely expose a token. Blanked
 * regions emit a separator (space), never nothing, so two tokens cannot fuse
 * across a removed comment/token (e.g. a block comment between `await` and
 * `fetch` still leaves a boundary).
 *
 * `blankStrings=false` is the comments-only mode the import gate needs: string
 * LITERALS survive verbatim (specifiers live in them) but comment markers
 * inside a string are not mis-read as comments. `blankStrings=true` is the
 * ambient-gate mode.
 */
function lexBlank(source: string, blankStrings: boolean): string {
  let i = 0;
  const n = source.length;
  let out = "";
  const emit = (text: string): void => {
    out += text;
  };

  function lex(mode: "top" | "expr"): void {
    let depth = 1; // only meaningful in expr mode
    while (i < n) {
      const ch = source[i]!;
      if (mode === "expr") {
        if (ch === "}") {
          depth--;
          if (depth === 0) return; // leave i on the closing brace
          emit(ch);
          i++;
          continue;
        }
        if (ch === "{") {
          depth++;
          emit(ch);
          i++;
          continue;
        }
      }
      if (ch === "/" && source[i + 1] === "/") {
        i += 2;
        while (i < n && source[i] !== "\n") i++;
        emit(" ");
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        emit(" ");
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
          if (source[i] === "\n") emit("\n");
          i++;
        }
        i += 2;
        emit(" ");
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        emit(blankStrings ? " " : quote);
        i++;
        while (i < n && source[i] !== quote) {
          const c = source[i]!;
          if (c === "\\") {
            if (source[i + 1] === "\n") emit("\n");
            else if (!blankStrings) emit(c + (source[i + 1] ?? ""));
            i += 2;
            continue;
          }
          if (c === "\n") {
            // Unterminated string: keep the newline so line numbers survive.
            emit("\n");
            i++;
            break;
          }
          if (!blankStrings) emit(c);
          i++;
        }
        if (source[i] === quote) {
          emit(blankStrings ? " " : quote);
          i++;
        } else if (blankStrings) {
          emit(" ");
        }
        continue;
      }
      if (ch === "`") {
        emit(blankStrings ? " " : "`");
        i++;
        while (i < n && source[i] !== "`") {
          const c = source[i]!;
          if (c === "\\") {
            if (source[i + 1] === "\n") emit("\n");
            else if (!blankStrings) emit(c + (source[i + 1] ?? ""));
            i += 2;
            continue;
          }
          if (c === "$" && source[i + 1] === "{") {
            if (!blankStrings) emit("${");
            i += 2;
            lex("expr");
            if (source[i] === "}") {
              if (!blankStrings) emit("}");
              i++;
            }
            continue;
          }
          if (c === "\n") emit("\n");
          if (!blankStrings) emit(c);
          i++;
        }
        if (source[i] === "`") {
          emit(blankStrings ? " " : "`");
          i++;
        } else if (blankStrings) {
          emit(" ");
        }
        continue;
      }
      emit(ch);
      i++;
    }
  }

  lex("top");
  return out;
}

/** Comments-only blanking (string literals preserved) for the import gate. */
function blankComments(source: string): string {
  return lexBlank(source, false);
}

/** Comments + string/template-literal blanking for the ambient gate. */
function scanAmbient(source: string): string {
  return lexBlank(source, true);
}

/**
 * Extract string specifiers from `import/export ... from "x"`, `import "x"`,
 * dynamic `import("x")`, and `require("x")`. Type-only imports are included
 * on purpose: `import type { X } from "y"` still couples the kernel to `y`
 * at the type layer. Callers pass `blankComments(...)` output, so a comment
 * mentioning an import is not mistaken for one.
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
    const source = blankComments(readFileSync(module, "utf8"));
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
 * Non-vacuous pin for the shared lexer (campaign 3, iteration 1). The
 * pre-change regex `stripComments` blanked `//` even inside a string, so a
 * string like `"use // to comment"` truncated the line and a specifier after
 * it vanished from the import scan. The lexer must (a) NOT treat a comment
 * marker inside a string as a comment, and (b) still find the real specifier.
 */
test("kernel purity: the import gate is string-aware (a // inside a string is not a comment)", () => {
  const synthetic = [
    '// import "node:fake";', // a real comment: must NOT be reported
    'const url = "https://example.test/a//b"; import "node:real";', // // is inside the string
  ].join("\n");
  // The comment is stripped (fake not found); the specifier after the string
  // survives because the `//` inside the string is not a comment.
  assert.deepEqual(moduleSpecifiers(blankComments(synthetic)), ["node:real"]);
});

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
