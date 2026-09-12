import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Thin Workflow-side client for the project-memory MCP server. Used by the
 * compaction bridge: recall relevant durable memory at session start, flush
 * durable outcomes after each run. Memory content is untrusted assertion
 * data, never authority.
 */

export type MemoryKind = "fact" | "decision" | "constraint" | "lesson";

export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly paths: readonly string[];
  readonly createdAt: number;
  readonly status: "current" | "superseded";
  readonly evidenceClass: "assertion";
  readonly freshness: "fresh" | "stale";
  readonly provenance: { readonly origin: string; readonly workspace: string };
}

export interface ProjectMemory {
  recall(query: string, limit: number): Promise<readonly MemoryRecord[]>;
  record(kind: MemoryKind, content: string, paths?: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export function createProjectMemoryClient(options: {
  readonly serverScript: string;
  readonly workspaceRoot: string;
  readonly dataDir?: string;
}): Promise<ProjectMemory> {
  const client = new Client({ name: "workflow-compaction-bridge", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverScript],
    stderr: "pipe",
    ...(options.dataDir === undefined ? {} : { env: { PROJECT_MEMORY_DATA_DIR: options.dataDir } }),
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`project-memory ${name} failed: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };

  const ready = client.connect(transport).then(() => {
    return {
      async recall(query: string, limit: number): Promise<readonly MemoryRecord[]> {
        const result = await call("search_memory", { workspaceRoot: options.workspaceRoot, query, limit }) as { records?: MemoryRecord[] };
        return result.records ?? [];
      },
      async record(kind: MemoryKind, content: string, paths: readonly string[] = []): Promise<void> {
        await call("record_memory", { workspaceRoot: options.workspaceRoot, kind, content, paths: [...paths] });
      },
      async close(): Promise<void> {
        await client.close();
      },
    } satisfies ProjectMemory;
  });

  return ready;
}

/**
 * Renders a bounded, provenance-tagged memory recall block for prompt
 * injection. Returns "" when there is nothing worth sending, so empty memory
 * never costs tokens.
 */
export function formatMemoryRecall(
  records: readonly MemoryRecord[],
  options: { readonly maxChars: number },
): string {
  if (records.length === 0) return "";
  const lines: string[] = [
    "# Project Memory (untrusted assertions from prior sessions — verify before relying on them)",
  ];
  let budget = options.maxChars - lines[0]!.length;
  for (const record of records) {
    const line = `- [${record.kind}] ${record.content}`;
    if (line.length + 1 > budget) break;
    lines.push(line);
    budget -= line.length + 1;
  }
  if (lines.length === 1) return "";
  const block = lines.join("\n");
  return block.length > options.maxChars ? `${block.slice(0, options.maxChars - 1)}…` : block;
}
