import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { TypeScriptLanguageService } from "../src/typescript-language-service.js";

const workspaceRoot = resolve("test/fixtures/typescript-project");

test("returns normalized syntactic and semantic diagnostics in deterministic order", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.diagnostics({ workspaceRoot, file: "src/main.ts", limit: 10 });

  assert.deepEqual(result, {
    diagnostics: [
      {
        severity: "error",
        code: 2322,
        message: "Type 'number' is not assignable to type 'string'.",
        file: "src/main.ts",
        line: 5,
        column: 14,
        endLine: 5,
        endColumn: 21,
      },
      {
        severity: "error",
        code: 1109,
        message: "Expression expected.",
        file: "src/main.ts",
        line: 6,
        column: 23,
        endLine: 6,
        endColumn: 24,
      },
    ],
    truncated: false,
  });
});

test("bounds diagnostics only when another permitted diagnostic exists", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.diagnostics({ workspaceRoot, file: "src/main.ts", limit: 1 });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.truncated, true);
});

test("returns an empty non-truncated diagnostic result for a clean file", async () => {
  const service = new TypeScriptLanguageService();
  assert.deepEqual(await service.diagnostics({ workspaceRoot, file: "src/math.ts", limit: 10 }), {
    diagnostics: [],
    truncated: false,
  });
});

test("honors an already-aborted diagnostic request", async () => {
  const service = new TypeScriptLanguageService();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.diagnostics({ workspaceRoot, file: "src/main.ts", limit: 10 }, controller.signal), {
    name: "AbortError",
  });
});

test("resolves workspace dependency typings for real-project diagnostics", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.diagnostics({
    workspaceRoot: resolve("../.."),
    file: "apps/code-intelligence-mcp/src/server.ts",
    limit: 100,
  });

  assert.ok(!result.diagnostics.some(({ code, message }) => code === 2307 && message.includes("'node:path'")));
});

test("finds a cross-file TypeScript definition with normalized 1-based coordinates", async () => {
  const service = new TypeScriptLanguageService();
  const definitions = await service.findDefinition({
    workspaceRoot,
    file: "src/main.ts",
    line: 3,
    column: 23,
  });

  assert.deepEqual(definitions, [{
    file: "src/math.ts",
    line: 1,
    column: 17,
    endLine: 1,
    endColumn: 23,
  }]);
});

test("finds bounded TypeScript references in deterministic source order", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.findReferences({
    workspaceRoot,
    file: "src/math.ts",
    line: 1,
    column: 17,
    limit: 10,
  });

  assert.deepEqual(result, {
    locations: [
      { file: "src/main.ts", line: 1, column: 10, endLine: 1, endColumn: 16 },
      { file: "src/main.ts", line: 3, column: 23, endLine: 3, endColumn: 29 },
      { file: "src/math.ts", line: 1, column: 17, endLine: 1, endColumn: 23 },
      { file: "src/math.ts", line: 12, column: 10, endLine: 12, endColumn: 16 },
    ],
    truncated: false,
  });
});

test("reports reference truncation only when another permitted reference exists", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.findReferences({ workspaceRoot, file: "src/math.ts", line: 1, column: 17, limit: 2 });
  assert.equal(result.locations.length, 2);
  assert.equal(result.truncated, true);
});

test("returns no references for an unresolved symbol", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.findReferences({ workspaceRoot, file: "src/main.ts", line: 4, column: 27, limit: 10 });
  assert.deepEqual(result, { locations: [], truncated: false });
});

test("omits references supplied by dependencies", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.findReferences({
    workspaceRoot: resolve("../.."),
    file: "apps/code-intelligence-mcp/src/server.ts",
    line: 6,
    column: 10,
    limit: 10,
  });
  assert.ok(result.locations.length > 0);
  assert.ok(result.locations.every(({ file }) => !file.split("/").includes("node_modules")));
});

test("honors an already-aborted reference request", async () => {
  const service = new TypeScriptLanguageService();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.findReferences({ workspaceRoot, file: "src/math.ts", line: 1, column: 17, limit: 10 }, controller.signal),
    { name: "AbortError" },
  );
});

test("finds references across the real Code Intelligence project", async () => {
  const service = new TypeScriptLanguageService();
  const monorepoRoot = resolve("../..");
  const result = await service.findReferences({
    workspaceRoot: monorepoRoot,
    file: "apps/code-intelligence-mcp/src/language-service.ts",
    line: 65,
    column: 3,
    limit: 20,
  });

  assert.deepEqual(result.locations.map(({ file }) => file), [
    "apps/code-intelligence-mcp/src/language-service.ts",
    "apps/code-intelligence-mcp/src/server.ts",
    "apps/code-intelligence-mcp/src/typescript-language-service.ts",
  ]);
  assert.equal(result.truncated, false);
});

test("returns flat document symbols in source order", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.documentSymbols({ workspaceRoot, file: "src/math.ts", limit: 10 });

  assert.deepEqual(result, {
    symbols: [
      { name: "double", kind: "function", file: "src/math.ts", line: 1, column: 1, endLine: 3, endColumn: 2 },
      { name: "Calculator", kind: "class", file: "src/math.ts", line: 5, column: 1, endLine: 9, endColumn: 2 },
      { name: "triple", kind: "method", file: "src/math.ts", line: 6, column: 3, endLine: 8, endColumn: 4 },
      { name: "calculate", kind: "function", file: "src/math.ts", line: 11, column: 1, endLine: 13, endColumn: 2 },
    ],
    truncated: false,
  });
});

test("reports document symbol truncation only when another symbol exists", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.documentSymbols({ workspaceRoot, file: "src/math.ts", limit: 2 });
  assert.equal(result.symbols.length, 2);
  assert.equal(result.truncated, true);
});

test("searches workspace symbols with normalized locations", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.workspaceSymbols({ workspaceRoot, query: "Calc", limit: 10 });

  assert.deepEqual(result, {
    symbols: [
      {
        name: "Calculator",
        kind: "class",
        file: "src/math.ts",
        line: 5,
        column: 1,
        endLine: 9,
        endColumn: 2,
      },
      {
        name: "calculate",
        kind: "function",
        file: "src/math.ts",
        line: 11,
        column: 1,
        endLine: 13,
        endColumn: 2,
      },
    ],
    truncated: false,
  });
});

test("reports workspace symbol truncation from an observed extra match", async () => {
  const service = new TypeScriptLanguageService();
  const result = await service.workspaceSymbols({ workspaceRoot, query: "Calc", limit: 1 });
  assert.equal(result.symbols.length, 1);
  assert.equal(result.truncated, true);
});

test("honors already-aborted symbol requests", async () => {
  const service = new TypeScriptLanguageService();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    service.documentSymbols({ workspaceRoot, file: "src/math.ts", limit: 10 }, controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(
    service.workspaceSymbols({ workspaceRoot: join(tmpdir(), "does-not-exist"), query: "Calc", limit: 10 }, controller.signal),
    { name: "AbortError" },
  );
});

test("does not discover workspace projects through configs outside the workspace", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "code-intelligence-workspace-config-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(parent, "outside.json"), JSON.stringify({ include: ["workspace/src/**/*.ts"] }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "../outside.json" }));
  writeFileSync(join(root, "src", "index.ts"), "export class EscapedConfig {}\n");

  const service = new TypeScriptLanguageService();
  await assert.rejects(
    service.workspaceSymbols({ workspaceRoot: root, query: "EscapedConfig", limit: 10 }),
    /No TypeScript projects found within workspace/,
  );
});

test("searches nested TypeScript projects in the real monorepo", async () => {
  const service = new TypeScriptLanguageService();
  const monorepoRoot = resolve("../..");
  const result = await service.workspaceSymbols({ workspaceRoot: monorepoRoot, query: "TypeScriptLanguageService", limit: 5 });

  assert.deepEqual(result.symbols.map(({ name, file }) => ({ name, file })), [{
    name: "TypeScriptLanguageService",
    file: "apps/code-intelligence-mcp/src/typescript-language-service.ts",
  }]);
  assert.equal(result.truncated, false);
});

test("returns no definitions for an unresolved symbol", async () => {
  const service = new TypeScriptLanguageService();
  const definitions = await service.findDefinition({
    workspaceRoot,
    file: "src/main.ts",
    line: 4,
    column: 27,
  });

  assert.deepEqual(definitions, []);
});

test("omits definitions supplied by dependencies", async () => {
  const service = new TypeScriptLanguageService();
  const definitions = await service.findDefinition({
    workspaceRoot: resolve("../.."),
    file: "apps/code-intelligence-mcp/src/server.ts",
    line: 6,
    column: 20,
  });

  assert.deepEqual(definitions, []);
});

test("rejects source paths that escape the workspace", async () => {
  const service = new TypeScriptLanguageService();
  await assert.rejects(
    service.findDefinition({ workspaceRoot, file: "../outside.ts", line: 1, column: 1 }),
    /outside the workspace/i,
  );
});

test("rejects symlinked source files that escape the workspace", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "code-intelligence-confinement-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside.ts");
  mkdirSync(root);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ files: ["linked.ts"] }));
  writeFileSync(outside, "export const secret = 1;\n");
  symlinkSync(outside, join(root, "linked.ts"));

  const service = new TypeScriptLanguageService();
  await assert.rejects(
    service.findDefinition({ workspaceRoot: root, file: "linked.ts", line: 1, column: 14 }),
    /outside the workspace/i,
  );
});

test("rejects tsconfig project files outside the workspace", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "code-intelligence-tsconfig-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "main.ts"), "export const local = 1;\n");
  writeFileSync(join(parent, "outside.ts"), "export const outside = 1;\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ files: ["main.ts", "../outside.ts"] }));

  const service = new TypeScriptLanguageService();
  await assert.rejects(
    service.findDefinition({ workspaceRoot: root, file: "main.ts", line: 1, column: 14 }),
    /project file is outside the workspace/i,
  );
});

test("rejects missing source files", async () => {
  const service = new TypeScriptLanguageService();
  await assert.rejects(
    service.findDefinition({ workspaceRoot, file: "src/missing.ts", line: 1, column: 1 }),
    /source file does not exist/i,
  );
});

test("rejects source positions beyond the end of the file", async () => {
  const service = new TypeScriptLanguageService();
  await assert.rejects(
    service.findDefinition({ workspaceRoot, file: "src/main.ts", line: 3, column: 500 }),
    /source position is outside the file/i,
  );
});

test("honors an already-aborted semantic request", async () => {
  const controller = new AbortController();
  controller.abort();
  const service = new TypeScriptLanguageService();

  await assert.rejects(
    service.findDefinition({ workspaceRoot, file: "src/main.ts", line: 3, column: 23 }, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});
