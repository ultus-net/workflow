const MCP_MUTATION_VERB_RE = /(?:^|_)(?:create|update|delete|remove|merge|push|close|edit|set|fork|trigger|cancel|rerun|add|assign|approve|complete|abandon)(?:_|$)/;
const MCP_READ_ONLY_RE = /(?:^|_)(?:get|list|search|show|query|describe|find|read|status|diff|log)(?:_|$)/;
const GUARDED_MCP_SERVERS = new Set(["github", "gh", "azure", "azmcp", "ado", "devops", "azuredevops"]);

export function mcpMutationTarget(toolName: string): string | undefined {
  if (!MCP_MUTATION_VERB_RE.test(toolName) || MCP_READ_ONLY_RE.test(toolName)) return undefined;
  const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.some((token) => GUARDED_MCP_SERVERS.has(token)) ? "GitHub/Azure DevOps" : undefined;
}
