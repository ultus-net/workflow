#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaultDataRoot, ReviewStore, SEVERITIES } from "./reviews.js";

const server = new McpServer({ name: "review-accountability-mcp", version: "0.1.0" });
const store = new ReviewStore(defaultDataRoot());
const severity = z.enum(SEVERITIES);
const subject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), repository: z.string().min(1).max(4096), commit: z.string().regex(/^[0-9a-fA-F]{40,64}$/) }),
  z.object({ kind: z.literal("fingerprint"), algorithm: z.string().min(1).max(200), version: z.string().min(1).max(200), scope: z.string().min(1).max(200), value: z.string().min(1).max(200) }),
]);
const finding = z.object({ severity, summary: z.string().min(1).max(1024), paths: z.array(z.string().min(1).max(500)).max(20).default([]) });
const followUp = finding.extend({ id: z.string(), reviewId: z.string(), status: z.enum(["open", "resolved"]), createdAt: z.number(), resolvedAt: z.number().optional(), resolution: z.string().optional() });
const review = z.object({
  id: z.string(), reviewer: z.string(), verdict: z.enum(["approved", "changes_requested"]), subject,
  blockingSeverities: z.array(severity), findings: z.array(finding), createdAt: z.number(), evidenceClass: z.literal("attestation"),
  provenance: z.object({ origin: z.literal("review-accountability-mcp/record_review"), workspace: z.string() }),
  freshness: z.enum(["fresh", "stale", "unknown"]), followUps: z.array(followUp),
});

server.registerTool("record_review", {
  description: "Call after an actual secondary review to persist its bounded attestation against an explicit content-sensitive subject; P2/P3 findings become durable follow-ups. This tool records a review but does not perform one.",
  inputSchema: { workspaceRoot: z.string().min(1).max(4096), reviewer: z.string().min(1).max(200), verdict: z.enum(["approved", "changes_requested"]), subject, blockingSeverities: z.array(severity).min(1).max(4), findings: z.array(finding).max(20).default([]) },
  outputSchema: { review }, annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
}, async (input, extra) => {
  const recorded = await store.recordReview(input, extra.signal); const structuredContent = { review: recorded };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

server.registerTool("list_reviews", {
  description: "Proactively call before finalizing or handing off changed work to recover review state and unresolved follow-up debt. Lists bounded review attestations; freshness is unknown unless a comparable current subject is supplied.",
  inputSchema: { workspaceRoot: z.string().min(1).max(4096), currentSubject: subject.optional(), limit: z.number().int().positive().max(50).default(20), followUpLimit: z.number().int().positive().max(50).default(20) },
  outputSchema: { reviews: z.array(review), openFollowUps: z.array(followUp), truncated: z.boolean(), followUpsTruncated: z.boolean() }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async (input, extra) => {
  const result = await store.listReviews(input, extra.signal); const structuredContent = result;
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

server.registerTool("resolve_followup", {
  description: "Call after the underlying P2/P3 issue has been fixed and verified to resolve its durable follow-up without rewriting the originating review attestation.",
  inputSchema: { workspaceRoot: z.string().min(1).max(4096), followUpId: z.string().min(1).max(200), resolution: z.string().min(1).max(1024) },
  outputSchema: { followUp }, annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
}, async (input, extra) => {
  const resolved = await store.resolveFollowUp(input, extra.signal); const structuredContent = { followUp: resolved };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

await server.connect(new StdioServerTransport());
