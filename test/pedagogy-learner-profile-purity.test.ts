import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as learnerProfile from "../src/pedagogy/learner-profile.js";

/**
 * W206 (M6): the purity gate for the plane's learner-profile module.
 *
 * M6 (integration-plan §F item 2, option (a)) makes `learning-mcp` the SOLE
 * writer of `learner-profile.json`. This module therefore holds no write path
 * and no lock. The gate pins that as a CONTRACT, not a review habit:
 *
 *   1. the module's public API carries no filesystem-write or lock surface;
 *   2. the module's source names no write/rename/mkdir/lock syscall (a
 *      behavioural "it did not write this one file" check would pass for a
 *      write to any OTHER path, so the source is scanned instead);
 *   3. the module's imports reach no `node:fs` write call and no assistant
 *      subtree module.
 *
 * Bounded claim: this is a source-level scan of ONE module, string-aware
 * around comments but with the repo's usual regex-literal caveat. It is not a
 * whole-program IO proof. It is the pin that makes a re-introduced plane writer
 * fail CI rather than merge.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = join(repoRoot, "src", "pedagogy", "learner-profile.ts");

/** Blank line and block comments, preserving line structure (module-local copy). */
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
      } else out += " ";
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

test("W206: the learner-profile module exports no filesystem-write or lock surface", () => {
  const exports = Object.keys(learnerProfile);
  const forbidden = [
    "saveLearnerProfile",
    "updateLearnerProfile",
    "acquireLearnerProfileLock",
    "lockIsStale",
    "sleepSync",
  ];
  for (const name of forbidden) {
    assert.ok(!exports.includes(name), "the plane module must not export write/lock surface: " + name);
  }
  // The pure surface that MUST remain.
  for (const name of ["createLearnerProfile", "recordLearningEvidence", "selectLearningOpportunity", "parseLearnerProfile"]) {
    assert.ok(exports.includes(name), "the pure surface must remain: " + name);
  }
});

test("W206: the learner-profile module source names no write/rename/mkdir/lock syscall", () => {
  const source = blankComments(readFileSync(modulePath, "utf8"));
  const forbidden = [
    /\bwriteFileSync\b/,
    /\brenameSync\b/,
    /\bmkdirSync\b/,
    /\bopenSync\b/,
    /\bunlinkSync\b/,
    /\bcloseSync\b/,
    /\bappendFileSync\b/,
    /\.lock\b/,
    /\bacquireLearnerProfileLock\b/,
  ];
  const violations: string[] = [];
  source.split("\n").forEach((line, index) => {
    for (const pattern of forbidden) {
      if (pattern.test(line)) violations.push(String(index + 1) + ": " + line.trim());
    }
  });
  assert.deepEqual(violations, [], "the plane learner-profile module must hold no write path:\n" + violations.join("\n"));
});

test("W206: the module imports no assistant subtree and no fs write call", () => {
  const source = blankComments(readFileSync(modulePath, "utf8"));
  const specifiers: string[] = [];
  const patterns = [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  for (const specifier of specifiers) {
    assert.ok(!specifier.includes("/assistant"), "the plane must not import the assistant subtree: " + specifier);
  }
  // The only fs names it may import are read-only.
  const fsImport = specifiers.find((s) => s === "node:fs");
  if (fsImport !== undefined) {
    const line = source.split("\n").find((l) => l.includes("node:fs")) ?? "";
    for (const writeCall of ["writeFileSync", "renameSync", "mkdirSync", "openSync", "unlinkSync", "closeSync"]) {
      assert.ok(!line.includes(writeCall), "the module may import only read-only node:fs names, found: " + writeCall);
    }
  }
});

test("W206: recordLearningEvidence is a pure in-memory merge (no disk IO)", () => {
  const profile = learnerProfile.createLearnerProfile();
  learnerProfile.recordLearningEvidence(profile, {
    concept: "x",
    kind: "demonstrated",
    summary: "in-memory only",
    timestamp: 1,
  });
  assert.equal(profile.concepts["x"]?.stage, "demonstrated");
  // Nothing was persisted: a fresh profile is still empty, and there is no file
  // path in the module to have written to.
  assert.deepEqual(learnerProfile.createLearnerProfile(), learnerProfile.createLearnerProfile());
});
