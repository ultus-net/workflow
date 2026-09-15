# skills-mcp

Hub-owned skills delivery over MCP (plan Task F1). `list_skills` is
metadata-only; `read_skill` is the single content delivery path. Skills are
screened at ingestion and delivery — malicious-shaped content (remote-code-
execution pipelines, credential harvesting, instruction hijacking, hidden
unicode, oversized payloads) is quarantined and surfaced with findings.
Availability and read access are gated by the operator-managed `levels.json`
(pedagogical modes to unlocked/required), with honest `off`/`active`/`closed`
states that fail closed.

Configuration: `SKILLS_MCP_DIR` (default `~/.agents/skills`),
`SKILLS_MCP_LEVEL` (optional pedagogical mode).

Honest limits: screening is heuristic, not a sandbox — the guard dispatcher
still gates every executed command at run time, and prompts are never a
security boundary. Delivery is enforced; adherence is not.