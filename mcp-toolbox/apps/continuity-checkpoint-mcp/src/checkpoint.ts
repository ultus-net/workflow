export interface ContinuityPort {
  review(query: { workspaceRoot: string; limit: number; followUpLimit: number }, signal?: AbortSignal): Promise<unknown>;
  verification(query: { workspaceRoot: string; limit: number }, signal?: AbortSignal): Promise<unknown>;
  context(query: { workspaceRoot: string; limit: number }, signal?: AbortSignal): Promise<unknown>;
  memory(query: { workspaceRoot: string; query: string; limit: number }, signal?: AbortSignal): Promise<unknown>;
}

export interface CheckpointQuery {
  workspaceRoot: string;
  memoryQuery: string;
  maxChars: number;
  sourceLimit: number;
}

const SOURCES = ["review", "verification", "project_context", "project_memory"] as const;
type SourceName = (typeof SOURCES)[number];

export async function recoverContinuity(query: CheckpointQuery, port: ContinuityPort, signal?: AbortSignal) {
  const values = await Promise.all([
    port.review({ workspaceRoot: query.workspaceRoot, limit: query.sourceLimit, followUpLimit: query.sourceLimit }, signal),
    port.verification({ workspaceRoot: query.workspaceRoot, limit: query.sourceLimit }, signal),
    port.context({ workspaceRoot: query.workspaceRoot, limit: query.sourceLimit }, signal),
    port.memory({ workspaceRoot: query.workspaceRoot, query: query.memoryQuery, limit: query.sourceLimit }, signal),
  ]);
  const sections = SOURCES.map((source, index) => ({ source, text: `${source}:\n${JSON.stringify(values[index])}\n` }));
  let remaining = query.maxChars;
  let context = "";
  const included: SourceName[] = [];
  let truncated = false;

  for (const section of sections) {
    if (section.text.length > remaining) { truncated = true; break; }
    context += section.text;
    remaining -= section.text.length;
    included.push(section.source);
  }

  return {
    context,
    includedSources: included,
    omittedSources: SOURCES.filter((source) => !included.includes(source)),
    truncated,
    sourceOrder: SOURCES,
  };
}
