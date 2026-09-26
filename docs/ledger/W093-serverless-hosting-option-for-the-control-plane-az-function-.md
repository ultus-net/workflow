<!-- Ledger fragment: extracted from TASKS.md at line 2200 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W093 - Serverless hosting option for the control plane (AZ Function) (Planned — intent recorded, design queued)

**Operator intent (2026-09-22):** the control plane will likely run as an
Azure Function — a serverless hosting option alongside the local daemon.

**Status: intent + constraints only. No design, no claims.** The hub today
is a local daemon: plane 3 binds loopback-only (`127.0.0.1`, discovery-file
tokens), plane 3′ is the uncredentialed browser channel
(`THREAT_MODEL.md`-accepted **loopback** posture), agent transports are
local stdio/ACP, containment is bwrap, and durable state is local files.
Remote hosting re-opens each of these as a design question, per the
protocol-planes doc (`docs/PROTOCOL_PLANES_2026-09-22.md`):

- **Auth becomes mandatory**: off-loopback, plane 3's bearer-token classes
  (operator vs verifier) become network credentials; the plane-3′
  uncredentialed channel cannot exist remotely and needs a credentialed
  replacement or explicit scope removal.
- **Agent transports**: stdio ACP runtimes are local; hosted agents go
  through the remote-ACP bridge (draft, advisory — `OPENCODE_REMOTE_ACP_
  SPEC.md`) or stay local while the control plane is remote.
- **Containment**: bwrap is a local-runtime primitive; contained-shell
  semantics (`/bash`, run gates) need a runtime decision (Azure container
  jobs? drop to advisory?).
- **Durable state**: local JSON stores → a durable remote store decision
  (per `DURABLE_STATE_INVENTORY.md` writer authorities).
- **Long-running loops**: the RSI loop and scheduler tick are
  long-lived/periodic — a consumption-based function needs durable-function
  or timer-trigger shaping.

**Acceptance criteria:**
- [ ] A hosting assessment (AZ Function vs container-app vs stay-local,
      per the four-plane map) with the THREAT_MODEL re-read — before any
      hosting code.
- [ ] The plane map re-stated for the hosted topology (what moves, what
      stays local, what the credential model becomes).
- [ ] Operator decision recorded before implementation.
