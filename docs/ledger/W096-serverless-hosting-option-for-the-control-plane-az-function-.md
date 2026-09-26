<!-- Ledger fragment: extracted from TASKS.md at line 2357 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W096 - Serverless hosting option for the control plane (AZ Function) (Planned - intent + constraints only)

**Operator intent (2026-09-22):** the control plane will likely run as an
Azure Function - a serverless hosting option alongside the local daemon.
**Status: intent recorded; design queued.** Remote hosting re-opens, per
docs/PROTOCOL_PLANES_2026-09-22.md: plane 3 auth (off-loopback, the
operator/verifier credential classes become network credentials), the
plane-3-prime uncredentialed browser channel (cannot exist remotely -
credentialed replacement or explicit scope removal), agent transports (stdio
ACP runtimes stay local or go through the advisory remote-ACP bridge),
containment (bwrap is local-runtime; /bash and run gates need a runtime
decision), durable state (local JSON stores -> durable remote store per the
DURABLE_STATE_INVENTORY.md writer authorities), and long-running loops
(RSI/scheduler -> durable-function or timer-trigger shaping).

**DUPLICATE (found 2026-09-24, contradiction sweep):** this item
duplicates W093 — same operator intent (2026-09-22), same title, same
open hosting-assessment criterion — recorded twice during that session.
W096 carries the fuller constraint enumeration (the plane map's five
re-opened surfaces); W093 carries the plane-3 loopback facts. The
canonical resolution (merge into one item or supersede one) is the
operator's call — both are operator-intent records, not agent-authored
design. No work is queued twice: the hosting assessment criterion is the
same single deliverable.

**Acceptance criteria:**
- [ ] A hosting assessment (AZ Function vs container-app vs stay-local,
      per the plane map) with the THREAT_MODEL re-read - before any
      hosting code.
- [ ] The plane map re-stated for the hosted topology.
- [ ] Operator decision recorded before implementation.
