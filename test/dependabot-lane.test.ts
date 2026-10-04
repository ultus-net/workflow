import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * W188 (campaign iteration 1, change-type: config): the W185 SHA pins need an
 * update lane or they rot. W185 made every root workflow `uses:` an immutable
 * commit; nothing advances that commit when upstream releases, so the pin
 * silently ages while `security` intent reads as "pinned = safe".
 *
 * This pin keeps the update lane honest: a `.github/dependabot.yml` exists,
 * declares version 2, has a top-level `updates:` list, and carries exactly one
 * `github-actions` updater scoped to the repo root, with a bounded schedule
 * and none of the documented kill switches that make a lane silently inert
 * (`open-pull-requests-limit: 0`, a blanket `ignore: dependency-name "*"`, or
 * a `target-branch`). The W185 `workflow-action-pins` shape pin stays the
 * authoritative enforcement against a regression to a mutable tag.
 *
 * The checks test the PROPERTY, not a spelling: the file is normalized
 * (full-line and inline comments stripped, single/double quotes removed, keys
 * read as `key : value` with optional whitespace before the colon) and the
 * kill switches are read as parsed values (`Number(value) === 0`, an all-stars
 * glob), so `'0'`/`0`/`00`/`+0`/`0x0` and `"*"`/`"**"` are all caught. It is
 * still not a YAML validator: it assumes the conventional block form (it does
 * not model flow mappings for scalar keys or Dependabot grouping beyond
 * rejecting `multi-ecosystem-group`). The root scoping is deliberately strict:
 * only `directory: /` satisfies it, so `./` would fail.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(repoRoot, ".github", "dependabot.yml");

/** The documented `schedule.interval` values (Dependabot). `cron` is
 * intentionally excluded (it additionally needs a `cronjob` field this pin
 * does not model). */
const INTERVALS = new Set(["daily", "weekly", "monthly", "quarterly", "semiannually", "yearly"]);

/** Remove a full-line comment or an inline ` # ...` comment. */
function stripComment(line: string): string {
  if (/^\s*#/.test(line)) return "";
  return line.replace(/\s#.*$/, "");
}

/** Normalize to a form where checks match values, not spellings: comments
 * gone, quotes gone. */
function normalize(source: string): string {
  return source
    .split("\n")
    .map((line) => stripComment(line).replace(/'/g, "").replace(/"/g, ""))
    .join("\n");
}

interface KeyValue {
  key: string;
  value: string;
}

/** Read every `key : value` pair (block or `- key: value` list item),
 * lowercasing the key and trimming the value. Whitespace before the colon is
 * allowed, since a YAML plain scalar key tolerates it. */
function keyValues(normalized: string): KeyValue[] {
  const pairs: KeyValue[] = [];
  for (const line of normalized.split("\n")) {
    const match = /^\s*(?:-\s*)?([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match) pairs.push({ key: match[1]!.toLowerCase(), value: match[2]!.trim() });
  }
  return pairs;
}

interface UpdateEntry {
  ecosystem: string;
  directory: string | undefined;
  block: string;
}

/**
 * Split the `updates:` list into per-entry blocks (dashes at the list's own
 * indentation, so a comment or a nested list never ends an entry) and read
 * each block's `package-ecosystem` and `directory` independently of order.
 */
function updateEntries(normalized: string): UpdateEntry[] {
  const lines = normalized.split("\n");
  const listIndent = lines.reduce<number | undefined>((found, line) => {
    if (found !== undefined) return found;
    const match = /^(\s*)-\s/.exec(line);
    return match ? match[1]!.length : undefined;
  }, undefined);
  if (listIndent === undefined) return [];

  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const dash = /^(\s*)-\s+/.exec(line);
    if (dash && dash[1]!.length === listIndent) {
      if (current) blocks.push(current);
      current = [line.replace(/^\s*-\s*/, "")];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);

  const entries: UpdateEntry[] = [];
  for (const block of blocks) {
    const text = block.join("\n");
    const pairs = keyValues(text);
    const ecosystem = pairs.find((pair) => pair.key === "package-ecosystem");
    if (!ecosystem) continue;
    const directory = pairs.find((pair) => pair.key === "directory");
    entries.push({ ecosystem: ecosystem.value, directory: directory?.value, block: text });
  }
  return entries;
}

test("W188: .github/dependabot.yml declares a runnable root github-actions update lane", () => {
  const normalized = normalize(readFileSync(configPath, "utf8"));
  const pairs = keyValues(normalized);

  assert.ok(pairs.some((pair) => pair.key === "version" && pair.value === "2"), "dependabot.yml must declare version: 2");
  assert.ok(pairs.some((pair) => pair.key === "updates"), "dependabot.yml must carry a top-level `updates:` list");

  // Kill switches are read as PARSED VALUES across the whole file, so a switch
  // hoisted into a group construct or spelled unusually cannot hide.
  assert.ok(
    !pairs.some((pair) => pair.key === "open-pull-requests-limit" && Number(pair.value) === 0),
    "a lane is disabled by an open-pull-requests-limit of 0",
  );
  assert.ok(!pairs.some((pair) => pair.key === "target-branch"), "a lane targets a non-default branch");
  // Blanket ignore: an all-stars glob in either block (`dependency-name: *`,
  // including `**`) or flow (`{dependency-name: *}`) form.
  assert.doesNotMatch(normalized, /dependency-name\s*:\s*\*+(?=\s*(?:[}\],]|$))/m, "a lane ignores every dependency");
  assert.ok(!pairs.some((pair) => pair.key.includes("multi-ecosystem-group")), "grouped ecosystems are out of the modeled shape");

  const entries = updateEntries(normalized);
  const actions = entries.filter((entry) => entry.ecosystem === "github-actions");
  assert.equal(actions.length, 1, "exactly one github-actions updater is expected");
  assert.equal(actions[0]?.directory, "/", "the github-actions updater must scan the repo root");

  for (const entry of entries) {
    const entryPairs = keyValues(entry.block);
    assert.ok(entryPairs.some((pair) => pair.key === "schedule"), `"${entry.ecosystem}" updater has no schedule block`);
    const interval = entryPairs.find((pair) => pair.key === "interval");
    assert.ok(interval && INTERVALS.has(interval.value), `"${entry.ecosystem}" updater schedule needs a valid interval`);
  }

  // The lane must NOT wander into the vendored subtree: a foreign ecosystem
  // scan there would open PRs for dependencies this repo does not own.
  for (const entry of entries) {
    assert.equal(entry.directory, "/", `update lane for "${entry.ecosystem}" targets "${entry.directory}" — only the root is in scope`);
  }
});
