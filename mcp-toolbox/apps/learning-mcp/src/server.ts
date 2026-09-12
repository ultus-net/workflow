#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type LoggingLevel,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CHECKPOINT_CATEGORIES, EVIDENCE_KINDS, LEARNING_STAGES, PEDAGOGICAL_MODES } from "./contracts.js";
import { DecisionLedger, evaluateLearningCheckpoint } from "./engine.js";
import { defaultLearnerProfilePath, loadLearnerProfile, recordLearningEvidence, updateLearnerProfile } from "./learner-profile.js";

const PROFILE_RESOURCE_URI = "workflow://learner-profile";

const server = new McpServer(
  { name: "learning-mcp", version: "0.1.0" },
  { capabilities: { logging: {}, resources: { subscribe: true } } },
);
const profilePath = defaultLearnerProfilePath();
const ledger = new DecisionLedger();
const subscribedResourceUris = new Set<string>();

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function log(extra: Extra, level: LoggingLevel, tool: string, phase: string, detail?: string): void {
  void extra.sendNotification({
    method: "notifications/message",
    params: { level, logger: "learning-mcp", data: { tool, phase, ...(detail ? { detail } : {}) } },
  }).catch(() => {});
}

function progress(extra: Extra, step: number, phase: string): void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  void extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress: step, total: 3, message: phase },
  }).catch(() => {});
}

function notifyProfileUpdated(): void {
  if (!subscribedResourceUris.has(PROFILE_RESOURCE_URI)) return;
  void server.server.notification({ method: "notifications/resources/updated", params: { uri: PROFILE_RESOURCE_URI } }).catch(() => {});
}

server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
  subscribedResourceUris.add(request.params.uri);
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
  subscribedResourceUris.delete(request.params.uri);
  return {};
});

server.registerResource(
  "learner-profile",
  PROFILE_RESOURCE_URI,
  { description: "Persisted learner profile: every tracked concept with its monotonic stage and recent evidence.", mimeType: "application/json" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadLearnerProfile(profilePath), null, 2) }],
  }),
);

const candidateAnswers = z.array(z.object({ label: z.string().min(1), description: z.string().min(1) })).optional();
const socraticCheckpoint = z.object({
  concept: z.string(), category: z.enum(CHECKPOINT_CATEGORIES),
  teachableInsight: z.string(), socraticQuestion: z.string(), candidateAnswers,
});
const gateOutput = {
  interrupt: z.boolean(), reason: z.string(),
  stage: z.enum(LEARNING_STAGES).optional(), checkpoint: socraticCheckpoint.optional(),
};
const evidenceKind = z.enum(EVIDENCE_KINDS);
const conceptState = z.object({
  stage: z.enum(LEARNING_STAGES), lastObservedAt: z.number(),
  evidence: z.array(z.object({ concept: z.string(), kind: evidenceKind, summary: z.string(), timestamp: z.number() })),
});
const decisionInput = {
  title: z.string().min(1).max(500), context: z.string().min(1).max(4096),
  proposedChoice: z.object({
    name: z.string().min(1).max(200), rationale: z.string().min(1).max(2048),
    blastRadius: z.enum(["low", "medium", "high"]),
  }),
  rejectedAlternatives: z.array(z.object({ name: z.string().min(1).max(200), drawback: z.string().min(1).max(2048) })).max(20),
  tradeoffs: z.object({
    benefits: z.array(z.string().min(1).max(500)).max(20),
    liabilities: z.array(z.string().min(1).max(500)).max(20),
  }),
};
const decisionBriefShape = z.object({
  briefId: z.string(), input: z.object(decisionInput),
  status: z.enum(["pending", "approved", "rejected"]), note: z.string().optional(),
});

server.registerTool(
  "learning_checkpoint",
  {
    description: "Consult the pedagogy engine before interrupting the learner with a Socratic checkpoint. Enforces per-mode gating: autonomous never interrupts; socratic-tutor enforces the session intervention budget (default 3); mastered concepts are suppressed unless marked needs-reinforcement; concepts whose prerequisites need reinforcement are suppressed. When interrupt is true, exposed evidence is recorded in the learner profile.",
    inputSchema: {
      concept: z.string().min(1).max(200), category: z.enum(CHECKPOINT_CATEGORIES),
      relevance: z.number().min(0).max(1), consequence: z.number().min(0).max(1),
      teachableInsight: z.string().min(1).max(2048), socraticQuestion: z.string().min(1).max(2048),
      candidateAnswers,
      mode: z.enum(PEDAGOGICAL_MODES),
      sessionInterventions: z.number().int().min(0),
      maxInterventions: z.number().int().positive().max(20).optional(),
    },
    outputSchema: gateOutput,
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (input, extra) => {
    log(extra, "debug", "learning_checkpoint", "profile-load");
    progress(extra, 1, "profile-loaded");
    let structuredContent: { interrupt: boolean; reason: string; stage?: string; checkpoint?: object } | undefined;
    let interrupted = false;
    updateLearnerProfile((profile) => {
      const evaluated = evaluateLearningCheckpoint(profile, input, {
        mode: input.mode, sessionInterventions: input.sessionInterventions, maxInterventions: input.maxInterventions,
      });
      interrupted = evaluated.interrupt;
      structuredContent = {
        interrupt: evaluated.interrupt, reason: evaluated.reason,
        ...(evaluated.stage ? { stage: evaluated.stage } : {}),
        ...(evaluated.checkpoint ? { checkpoint: evaluated.checkpoint } : {}),
      };
    }, profilePath);
    log(extra, "debug", "learning_checkpoint", "gate-evaluation", `interrupt=${interrupted}`);
    progress(extra, 2, "gate-evaluated");
    if (interrupted) {
      log(extra, "info", "learning_checkpoint", "evidence-persist", input.concept);
      notifyProfileUpdated();
    }
    progress(extra, 3, "evidence-recorded");
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent: structuredContent! };
  },
);

server.registerTool(
  "record_learning_evidence",
  {
    description: "Record observed learning evidence for a concept. Stage progression is monotonic: evidence never regresses a concept to an earlier stage; needs-reinforcement flags the concept for review without lowering its stage.",
    inputSchema: { concept: z.string().min(1).max(200), kind: evidenceKind, summary: z.string().min(1).max(2048) },
    outputSchema: { concept: z.string(), stage: z.enum(LEARNING_STAGES) },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (input, extra) => {
    log(extra, "debug", "record_learning_evidence", "profile-load");
    const updated = updateLearnerProfile((profile) => {
      recordLearningEvidence(profile, { concept: input.concept, kind: input.kind, summary: input.summary, timestamp: Date.now() });
    }, profilePath);
    log(extra, "info", "record_learning_evidence", "evidence-persist", input.concept);
    notifyProfileUpdated();
    const structuredContent = { concept: input.concept, stage: updated.concepts[input.concept]!.stage };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "decision_checkpoint",
  {
    description: "Record a decision brief before committing to an architectural approach (co-architect mode). The brief is stored in the session ledger and always requires human approval before mutation proceeds.",
    inputSchema: decisionInput,
    outputSchema: { briefId: z.string(), requiresHumanApproval: z.literal(true), brief: decisionBriefShape },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (input, extra) => {
    const { briefId, brief } = ledger.record(input);
    log(extra, "info", "decision_checkpoint", "ledger-op", `recorded ${briefId}`);
    const structuredContent = { briefId, requiresHumanApproval: true as const, brief };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "resolve_decision_checkpoint",
  {
    description: "Resolve a pending decision brief with a human approval or rejection. Unknown brief ids are a tool error.",
    inputSchema: { briefId: z.string().min(1), approved: z.boolean(), note: z.string().max(2048).optional() },
    outputSchema: { brief: decisionBriefShape },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const brief = ledger.resolve(input.briefId, input.approved, input.note);
    log(extra, "info", "resolve_decision_checkpoint", "ledger-op", `resolved ${input.briefId}`);
    const structuredContent = { brief };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "learner_profile",
  {
    description: "Read the persisted learner profile: every tracked concept with its current monotonic stage and recent evidence.",
    inputSchema: {},
    outputSchema: { concepts: z.record(z.string(), conceptState) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (_args, extra) => {
    log(extra, "debug", "learner_profile", "profile-load");
    const profile = loadLearnerProfile(profilePath);
    const structuredContent = { concepts: profile.concepts };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
