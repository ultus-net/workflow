# W209 (M7): care-route withholding by tool NAME

Date: 2026-10-16. Branch: `feat/m7-care-tool-policy`. Base: `6dea4684`.

## Goal

Implement the deferral S4/S5 named: care's tool-NAME policy. The care route is
an identity-scoped route whose tool set is withheld by the authority, not a
prompt toggle. S4/S5 built the CAPABILITY half (`withheldCapabilities` →
`applyRouteCapabilities` → `application.setCapability` per run → the kernel
gate denies `CAPABILITY_WITHHELD`). But that layer FILTERS OUT any entry that is
not one of the six `ToolCapability` strings, so an operator who wrote
`WORKFLOW_CARE_WITHHELD=network,file_write,shell` withheld `network` and nothing
else. This slice makes the tool NAMES enforce too, fail closed, so a withheld
name can never be dispatched on the care route.

## The decision: two disjoint vocabularies, one list

`WORKFLOW_CARE_WITHHELD` is one comma-separated list threaded as the host's
`withheld`. The two layers read it through DISJOINT vocabularies:

| Entry | Layer | Effect |
| --- | --- | --- |
| one of the six capability names (`read`, `mutation`, `process`, `spawn`, `credentials`, `network`) | capability (`withheldCapabilities`) | the run's grant omits it; a call classifying to it denies `CAPABILITY_WITHHELD` at the kernel gate |
| anything else (`file_write`, `shell`, a typo) | tool name (`withheldToolNames`) | a care-route call naming it is denied terminally before any run/gate/dispatch |

Neither reading can consume the other: a capability name is never reinterpreted
as a tool name, and a tool name is never read as a capability. The named helper
`withheldToolNames(route, withheld, knownCapabilities)` makes the intent
legible and the split testable. `withheldCapabilities` is byte-for-byte
unchanged (same signature, same behavior).

**Fail closed on an unknown entry.** A name that is neither a known capability
nor a declared tool is STILL withheld as a tool name on the care route. An
operator typo (`fle_write`) withholds rather than grants, consistent with the
rest of the lane (undeclared tools classify to the strictest class; unknown
identities 403; no hub → error observation).

## What landed

**Edit:** `src/integrations/assistant-tool-host.ts`.

- New `withheldToolNames(route, withheld, knownCapabilities = ALL_TOOL_CAPABILITIES):
  ReadonlySet<string>`: empty for coding/tutor, else every entry not in the
  capability vocabulary.
- The tool-call lane checks it FIRST (after identity/workspace/call validation,
  before the run is resolved or begun). A hit returns a terminal error
  observation `tool '<name>' is withheld on the care route` with no dispatch
  directive, no run, no guard, no ask. Coding/tutor routes return an empty set,
  so an identical call there authorizes and delegates as before.
- The `withheld` option doc now states the vocabulary split.

**Unchanged:** `src/cli/hub.ts` already parses `WORKFLOW_CARE_WITHHELD` into
`careWithheld` and threads it as `withheld`; no change needed. The daemon
dispatcher's "fails closed on an undeclared tool" behavior is untouched. The
"hub authorizes every call" invariant and the per-run (never process-global)
capability application are untouched.

## Why deny before dispatch directive, not at the daemon

The hub is the authority for every call (topology Option B). A withheld NAME is
a route policy decision, so the hub decides it and returns a terminal
observation. The daemon therefore never receives an undecided or
policy-withheld call, and a withheld name leaks no dispatch directive the daemon
could mis-fulfill.

## Acceptance

- `npx tsc --noEmit` 0.
- `npm run lint` 0.
- `npm run build` clean.
- `node --import tsx --test test/hub-assistant-tool-route.test.ts test/assistant-withheld-enforcement.test.ts`
  13/13 and 13/13.
  - care-route call to a withheld NAME (`file_write`) denied, no dispatch;
  - the same NAME on a coding route is NOT denied (it delegates);
  - an undeclared tool still reaches the dispatcher under the strictest class
    (unchanged behavior);
  - capability withholding still denies `CAPABILITY_WITHHELD` and never
    dispatches;
  - `withheldToolNames`/`withheldCapabilities` split: a capability name is inert
    to the name layer and a tool name is inert to the capability layer; an
    unknown name is withheld (fail closed); coding/tutor withhold no names.
- `node --import tsx --test test/assistant-isolation.test.ts` still passes.

## Not in this slice

- No change to `test/ci-suites.txt`: no new suite file. The assertions extend
  the two existing registered suites (`test/hub-assistant-tool-route.test.ts`,
  `test/assistant-withheld-enforcement.test.ts`).
- A production `WORKFLOW_CARE_WITHHELD` value: the deployed plane sets it when
  the M7 care tool surface is fixed.
