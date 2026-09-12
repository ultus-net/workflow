# Client compatibility

Research date: 2026-08-27.

## Shared MCP baseline

Claude Code and OpenAI Codex both support local MCP servers over stdio. That makes a stdio MCP policy server a useful common denominator. Both ecosystems also support HTTP-based MCP connections, so a centrally hosted team policy service is feasible later.

The MCP protocol exposes server tools to the host. It does not, by itself, place the MCP server in front of native shell, filesystem, or other client tools. A model being told to call `guard_check` before acting is useful defense in depth, but it is not a security boundary.

## Claude Code

Claude Code supports stdio and HTTP MCP servers and project-oriented MCP configuration through `.mcp.json`. Claude Code also has a `PreToolUse` hook that runs before tool execution and can return an `allow`, `deny`, or `ask` permission decision. Anthropic's own hook guidance includes matching MCP tools in these hooks.

This gives us a path to strong Claude Code integration: a small host adapter can use `PreToolUse` to evaluate relevant native tool calls against the same policy engine. The adapter, rather than MCP alone, is the enforcement point.

Source: https://docs.claude.com/en/docs/claude-code/mcp

Source: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/SKILL.md

## OpenAI Codex

Codex supports MCP servers using stdio and Streamable HTTP. Its MCP configuration supports explicit `enabled_tools` and `disabled_tools` filtering. Current stdio MCP configuration exposes command, arguments, environment, inherited environment variables, and working directory; it does not give an MCP server native authority over the Codex sandbox or filesystem.

Codex has its own sandbox and approval policy. Those controls should remain enabled and should be treated as the primary hard containment boundary until/unless Codex exposes a supported pre-native-tool policy hook that can delegate decisions to this project.

Source: https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs

Source: https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/tools.rs

Example local configuration after the package is published:

```toml
[mcp_servers.workflow_guard]
command = "npx"
args = ["-y", "workflow-guard-mcp"]
enabled_tools = ["guard_check", "guard_status"]
```

Codex also provides `codex mcp add` for adding MCP servers to `~/.codex/config.toml`. Keep Codex's sandbox and approval settings independently configured; the MCP entry does not replace them.

## Claude Code project configuration

A project can expose the server through `.mcp.json` after the package is published:

```json
{
  "mcpServers": {
    "workflow-guard": {
      "command": "npx",
      "args": ["-y", "workflow-guard-mcp"]
    }
  }
}
```

Treat this connection as advisory until the planned `PreToolUse` adapter is installed. The adapter is what can turn the shared policy decision into a deny before a native Claude Code tool executes.

## Recommended team posture

Use this server as one layer rather than the only safety mechanism. Keep client sandboxes, approval prompts, least-privilege credentials, protected branches, CI checks, and infrastructure-side authorization in place. For Claude Code, add the planned `PreToolUse` adapter for enforceable local decisions. For Codex, use the MCP advisor alongside Codex's sandbox/approval controls until a supported interception surface is available.
