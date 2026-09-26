<!-- Ledger fragment: extracted from TASKS.md at line 1512 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W079 - Hash-anchored edits: evaluation against the read-fingerprint ledger (design doc)

**Objective:** Evaluate a Hashline-style upgrade (`LINE#ID` content-hash tags on reads, edits
validated against the tags) for the surfaces where Workflow owns the edit path, against the
implemented `FileClaimLedger` digest/size/mtime freshness (DRIFT-022). Idea adopted from
oh-my-openagent / "The Harness Problem"; no upstream code.

**Depends on:** W072 ledger invariants (fresh reads before mutation).

**Acceptance criteria:**
- [x] A dated design doc compares content-addressed line identity vs the current digest/size/mtime
      claim matching: capture points (where reads are surfaced), enforcement point (edit validation
      through the guard, not prompt text), adversarial cases (same-hash collisions, truncated
      reads), and a probe plan. (**Done 2026-09-20:**
      `docs/superpowers/specs/2026-09-20-w079-hashline-read-fingerprint-decision.md` — grounded in
      the as-built capture points (ACP fs-read lane + the v2 gateway claims) and the
      `STALE_OR_MISSING_READ` authorization gate.)
- [x] A decision with evidence: adopt, adapt, or reject — recorded in the doc; no code before the
      decision. (**Decision 2026-09-20: REJECT** — the current whole-file digest ledger is strictly
      more conservative on every adversarial case the doc examines: sha256 whole-file has no
      collision surface while per-line hashes collide trivially and need positional anchors that
      insertions invalidate; a truncated read claims whole-file freshness either way, so hashline
      degrades to the whole-file rule everywhere it matters; the enforcement point would not move —
      hashline only relaxes what counts as stale, which is the invariant the ledger exists to hold.
      The one real improvement the idea surfaced — recording a read window for windowed reads — is
      recorded in the doc as a scoped option requiring its own dated decision if the gateway lane
      ever surfaces windowed reads; the ACP lane does not today. No code shipped with this
      decision.)
