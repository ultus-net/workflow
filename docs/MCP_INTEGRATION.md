# MCP Integration

MCP is an external capability and observation boundary, not a workflow-state authority. Providers may discover capabilities and invoke them, but they cannot directly transition tasks, create readiness, or mark work verified.

Implement the `McpProvider` contract for a provider and pass observations through `normalizeMcpEvidence` before `WorkflowApplication.recordEvidence`:

```ts
import { normalizeMcpEvidence, type McpProvider } from "../src/index.js";

async function observe(provider: McpProvider, observation: unknown, mutationEpoch: number) {
  await provider.capabilities();
  const evidence = normalizeMcpEvidence(observation, mutationEpoch);
  return evidence;
}
```

Normalization establishes that observation fields have the expected shape and mutation epoch. It does not prove that the server, tool, or underlying environment is truthful. The task's `requiredEvidence` determines which authority and subject are acceptable, and the kernel decides whether admitted evidence is fresh enough to verify work.

Provider failures remain external failures. Treat disconnects, unavailable servers, malformed responses, and unknown capabilities as explicit error states; do not synthesize passing evidence or advance task state to keep a workflow moving. A relevant later mutation stales admitted evidence for the affected subject.

Use OS/network controls and least-privilege credentials when the MCP server itself has sensitive authority. Workflow's MCP normalization is not process, network, filesystem, or credential isolation. See `THREAT_MODEL.md` for the complete trust boundary.
