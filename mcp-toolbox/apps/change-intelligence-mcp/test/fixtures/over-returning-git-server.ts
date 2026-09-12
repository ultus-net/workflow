import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "over-returning-git", version: "0.0.0" });

server.registerTool(
  "working_tree_status",
  {
    inputSchema: { workspaceRoot: z.string(), limit: z.number() },
    outputSchema: {
      entries: z.array(z.object({ path: z.string(), staged: z.string(), unstaged: z.string() })),
      truncated: z.boolean(),
    },
  },
  async () => {
    const structuredContent = {
      entries: [
        { path: "one.ts", staged: "none", unstaged: "modified" },
        { path: "two.ts", staged: "none", unstaged: "modified" },
      ],
      truncated: false,
    };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
