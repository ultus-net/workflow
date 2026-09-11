# OpenCode replacement qualification

Qualification date: 2026-09-11

Result: qualified by the current Cline replacement matrix, subject to the final full verification and independent-review release gates. The previously observed direct `apply_patch` gap is closed through Cline's public `localRuntime.extraTools` surface, and OpenCode itself now has a separate authoritative plugin adapter plus host-neutral SDK session driver for interoperability.

## Matrix

| Scenario | Evidence | Result |
| --- | --- | --- |
| Clean repository inspect/edit/test/Git | `npm run test:cline-coding-session` starts from a committed fixture and drives a configured real Cline session | Pass |
| Dirty repository continued work | The same real session continues SDK editor/MCP operations after the initial mutation has made the fixture dirty | Pass |
| Multi-step dependency and verification lifecycle | `npm run test:cline-coding-session` plus application contracts | Pass |
| Restart and interrupted-work recovery | `npm run test:cline-resume` | Pass |
| SDK/runtime authorization and containment | `npm run test:cline-runtime` and `npm run test:e2e` | Pass |
| Cancellation, denial, malformed host input, containment failure, verification failure | Unit/application/containment suites under `npm test` | Pass when the full gate is green |
| SDK editor tool | Public `createDefaultTools` editor execution through the Workflow authorization seam in `test:cline-coding-session` | Pass |
| SDK `apply_patch` tool | `test:cline-coding-session` creates `apply_patch` independently through public `createDefaultTools`, registers it through public `localRuntime.extraTools`, authorizes it through Workflow, and verifies the resulting file | Pass |
| SDK-facing MCP | In-memory Cline `McpToolProvider` tool executes through the Workflow authorization seam; adapter tests cover least-privilege extension classification | Pass |
| Image prompt input | `WorkflowCodingSession` carries host-neutral `{ mediaType, data }` images and `ClineSessionDriver` translates them to the public `userImages` start input | Pass |
| OpenCode authoritative interoperability | OpenCode's public `tool.execute.before` plugin hook is translated through `OpenCodeHostAdapter`; denial throws before execution. `OpenCodeSessionDriver` mirrors the documented session create/prompt/abort and event-subscribe shapes while keeping SDK lifecycle telemetry outside policy authority | Contract-tested against the documented public API shapes; real OpenCode runtime E2E not yet claimed |

## Gaps

- No observed P2 daily-driver parity gap remains in this matrix. Direct Cline `apply_patch` uses the supported tool factory plus `localRuntime.extraTools`; Workflow does not implement a parallel model/tool loop.

No P0/P1 safety, state-integrity, or data-loss defect is known from this matrix. The final full verification and independent review remain separate release gates before changing the operator's default harness.
