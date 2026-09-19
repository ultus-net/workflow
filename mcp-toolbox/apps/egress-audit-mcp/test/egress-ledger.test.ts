import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EgressAuditLedger, normalizeDomain } from "../src/egress-ledger.js";

function withLedger<T>(fn: (ledger: EgressAuditLedger, dir: string) => Promise<T>, options?: { maxEntries?: number }): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "egress-audit-"));
  return fn(new EgressAuditLedger(dir, options), dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("append records a reach and query returns it newest-first", async () => {
  await withLedger(async (ledger) => {
    const first = await ledger.append({ domain: "api.example.com", functionClass: "models-list", tokenClass: "session-placeholder", source: "test", observedAt: 1000 });
    const second = await ledger.append({ domain: "api.example.com", functionClass: "models-list", tokenClass: "session-placeholder", source: "test", observedAt: 2000 });
    assert.deepEqual(first.anomalies, ["new-domain"]);
    assert.equal(second.anomalies.length, 0, "a repeat session-placeholder reach on the same function is not flagged");
    const { reaches, truncated } = await ledger.query({});
    assert.equal(truncated, false);
    assert.deepEqual(reaches.map((reach) => reach.id), [second.id, first.id]);
    assert.equal(reaches[0]?.recordedAt >= 0, true);
  });
});

test("anomaly flags distinguish a new domain from a new function class on a known domain", async () => {
  await withLedger(async (ledger) => {
    const known = await ledger.append({ domain: "api.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder" });
    assert.deepEqual(known.anomalies, ["new-domain"]);
    const repeat = await ledger.append({ domain: "api.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder" });
    assert.deepEqual(repeat.anomalies, []);
    const newFunction = await ledger.append({ domain: "api.example.com", functionClass: "file-upload", tokenClass: "session-placeholder" });
    assert.deepEqual(newFunction.anomalies, ["new-function-class-on-known-domain"]);
  });
});

test("non-session token classes are flagged and recorded flags are immutable", async () => {
  await withLedger(async (ledger) => {
    const foreign = await ledger.append({ domain: "api.example.com", functionClass: "chat-completions", tokenClass: "foreign" });
    assert.deepEqual(foreign.anomalies, ["new-domain", "non-session-token-observed"]);
    const absent = await ledger.append({ domain: "api.example.com", functionClass: "chat-completions", tokenClass: "absent" });
    assert.deepEqual(absent.anomalies, [], "an absent credential is not a non-session token observed");
    const unknown = await ledger.append({ domain: "other.example.com", functionClass: "webhook", tokenClass: "unknown" });
    assert.ok(unknown.anomalies.includes("non-session-token-observed"));

    // A later reach must not rewrite the flags stored on an earlier one.
    await ledger.append({ domain: "api.example.com", functionClass: "embeddings", tokenClass: "session-placeholder" });
    const reread = await ledger.query({ flaggedOnly: true });
    assert.equal(reread.reaches.find((reach) => reach.id === foreign.id)?.anomalies.includes("non-session-token-observed"), true);
  });
});

test("query bounds, filters, and truncation are enforced", async () => {
  await withLedger(async (ledger) => {
    for (let i = 0; i < 5; i += 1) {
      await ledger.append({ domain: i % 2 === 0 ? "a.example.com" : "b.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder", observedAt: 1000 + i });
    }
    const limited = await ledger.query({ limit: 2 });
    assert.equal(limited.reaches.length, 2);
    assert.equal(limited.truncated, true);
    const filtered = await ledger.query({ domain: "B.EXAMPLE.COM" });
    assert.equal(filtered.reaches.length, 2, "domain normalization applies to filters");
    const since = await ledger.query({ since: 1003 });
    assert.deepEqual(since.reaches.map((reach) => reach.observedAt), [1004, 1003]);
    await assert.rejects(() => ledger.query({ limit: 500 }), /1-200/);
  });
});

test("summarize aggregates domains, function classes, token classes, and anomaly counts", async () => {
  await withLedger(async (ledger) => {
    await ledger.append({ domain: "a.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder" });
    await ledger.append({ domain: "a.example.com", functionClass: "chat-completions", tokenClass: "foreign" });
    await ledger.append({ domain: "b.example.com", functionClass: "webhook", tokenClass: "session-placeholder" });
    const summary = await ledger.summarize();
    assert.equal(summary.entries, 3);
    assert.deepEqual(summary.byDomain, [
      { key: "a.example.com", count: 2 },
      { key: "b.example.com", count: 1 },
    ]);
    assert.deepEqual(summary.anomalies, [
      { flag: "new-domain", count: 2 },
      { flag: "new-function-class-on-known-domain", count: 0 },
      { flag: "non-session-token-observed", count: 1 },
    ]);
  });
});

test("the ledger is append-only and bounded: a full ledger refuses new appends without deleting history", async () => {
  await withLedger(async (ledger, dir) => {
    await ledger.append({ domain: "a.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder" });
    await ledger.append({ domain: "a.example.com", functionClass: "models-list", tokenClass: "session-placeholder" });
    await assert.rejects(
      () => ledger.append({ domain: "a.example.com", functionClass: "embeddings", tokenClass: "session-placeholder" }),
      /append-only/,
    );
    const persisted = JSON.parse(readFileSync(join(dir, "egress-audit-ledger.json"), "utf8")) as { entries: unknown[] };
    assert.equal(persisted.entries.length, 2, "history is never rotated or deleted");
  }, { maxEntries: 2 });
});

test("domain normalization rejects non-hostname shapes", () => {
  assert.equal(normalizeDomain("API.Example.COM"), "api.example.com");
  for (const bad of ["https://api.example.com", "api.example.com/path", "api.example.com:443", "user@api.example.com", "api example.com", "localhost", "192.168.0.1", "-bad.example.com"]) {
    assert.throws(() => normalizeDomain(bad), /hostname/, `must reject ${bad}`);
  }
});

test("a malformed ledger fails closed rather than returning partial data", async () => {
  await withLedger(async (ledger, dir) => {
    await ledger.append({ domain: "a.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder" });
    const path = join(dir, "egress-audit-ledger.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as { entries: Array<Record<string, unknown>> };
    document.entries[0]!.tokenClass = "attacker-supplied-token-class";
    writeFileSync(path, JSON.stringify(document));
    await assert.rejects(() => ledger.query({}), /malformed or unreadable/);
  });
});