# Claude Code Adapter

Claude Code exposes `PreToolUse` hooks that can return `allow`, `deny`, or `ask`. The `workflow-guard-claude-hook` executable maps supported native tool calls into the portable policy core and returns that decision using Claude Code's hook schema.

The initial adapter covers `Bash`, `Write`, `Edit`, and `NotebookEdit`. It uses the hook's `cwd` as the workspace root and fails closed when a matched tool call is malformed or unsupported. It does not execute Git or query remote services, so policies requiring current branch or other runtime facts need a future trusted fact-gathering adapter extension.

After installing and building the package, configure a command hook using the installed executable path:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "workflow-guard-claude-hook"
          }
        ]
      }
    ]
  }
}
```

This hook is an enforcement point for the matched Claude Code tools. It does not imply that MCP alone intercepts native tools, and tools not included in the matcher remain outside this adapter.
