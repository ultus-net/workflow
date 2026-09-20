# Hash-anchored edits: evaluation against the read-fingerprint ledger

**Date:** 2026-09-20 · **Item:** W077 · **Status:** evaluated — decision recorded below
**Idea source:** oh-my-openagent's Hashline ("The Harness Problem", Can Bölük; SUL-1.0 upstream —
pattern only, no code) · **Relation:** DRIFT-022 (`FileClaimLedger`, `requireReadFingerprint`)

## The shared invariant

Both systems enforce one claim: **a mutation may only land on bytes the actor actually observed.**
The failure they prevent is identical — the agent edits against a stale mental model of the file,
the user blames the model, and the corruption is real. They differ in *where* the identity lives:

| | FileClaimLedger (shipped) | Hashline (idea) |
| --- | --- | --- |
| Identity | file-level claim: digest + size + mtime, session-scoped | line-level: each surfaced read line tagged `LINE#ID` (content hash) |
| Validation | write checked against the ledger claim | each edit's tag checked against the file's current bytes |
| Granularity | whole file | exact lines |
| Failure mode caught | file changed since read (any cause) | stale line content, even inside an otherwise-fresh file |

## Evaluation

**Capture point.** Workflow owns the read surface in the contained fs/exec lane
(`workflow-fs-exec-mcp`, the hub-implemented server for ACP `--pure` agents): reads projected to
the agent can be tagged there without touching host internals. This is a control-plane surface —
no plugin, consistent with the no-plugins constraint (project memory, 2026-09-20).

**Enforcement point.** Validation happens in the *write tool*, deterministically: an edit
referencing a stale or absent tag fails closed before any bytes change. It is never prompt text
and never relies on the model's honesty — the guard's mutation gate remains the seat.

**Adversarial cases:** (a) hash collisions — use a strong short digest (e.g. 8+ hex chars of
sha256 of line content + line number + file epoch); (b) truncated/partial reads — tags are valid
only for lines actually surfaced, so an edit past the read window fails; (c) multi-edit batches —
each edit revalidates against the file's post-previous-edit bytes, which is what line identity is
for; (d) rebased files — the file-level ledger still catches wholesale replacement first.

**Cost:** the read surface grows by ~5–7% in tokens (tags on every line); the write tool gains a
validation mode. The claim ledger already pays a read-capture cost; this moves part of the failure
from runtime rejection to earlier, cheaper rejection.

## Decision: **adopt (adapted), scoped to Workflow-owned edit surfaces**

Line-hash tagging is adopted as a design direction for the fs-exec read/write path only, as a
*complement* — the file-level claim ledger remains the kernel invariant and the guard remains the
enforcement seat. Rationale: (1) it strictly refines the evidence story where we own both ends;
(2) it is the UX fix for the documented edit-failure class (stale-line errors) without any
prompt-side discipline; (3) it does not apply to host-builtin edit tools we do not own — there the
ledger stands alone. Implementation is a separate slice, probe-gated per pinned host version; no
claim attaches until then. Rejected alternative: adopting upstream Hashline code (license + it
targets a host tool we do not own).