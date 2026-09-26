<!-- Ledger fragment: extracted from TASKS.md at line 905 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W070b - Open-model optimization + deterministic tool-usage enforcement

**Status (2026-09-19, implemented + reviewed [APPROVE after P1 fix], integrated through main 0a0e126 + PR #44/c20eef3):** per-model replay policy enforced at the metering proxy (K3 preserved-thinking contract: stripped replay rejected 400 pre-upstream; DeepSeek mid-conversation tool-call synthesis diverted to the Anthropic-format path 409; adjacency rule fixed for parallel tool calls after reviewer-reproduced P1); DeepSeek strict-schema translator (canonical ModelProfile-keyed; `/beta` strict mode served via gated golden probe; production `/beta` endpoint selection deliberately deferred to a dedicated provider seam, documented in `docs/OPEN_MODEL_ENFORCEMENT.md`); guard deny-with-redirect text tightened; bounded tool-expected-turn steering (≤2 retries, monitor-visible, opt-in) — a behavioral nudge, never a security control; 13-pattern inventory of the retired workflow-guard plugin with per-pattern dispositions; vendor golden-probe corpus defined. **Residual:** steering dormant until a production caller passes `toolExpectedTurn`; strict-mode production wiring (W062 seam); one live probe run per vendor (keys).

### Checkpoint E - AI-landscape follow-ups landed

- [ ] Live vendor probes recorded per family (needs vendor keys) and off-peak delta measured or no-go'd.
- [ ] Attestation wired at the first post-W050 durable-state injection boundary; run-registry routing for supervisor findings.
- [ ] Strict-mode production seam (W062) and golden-probe verdicts recorded per vendor.
- [ ] W052/W065/W058/W059 and the remaining Phase 12 candidates scheduled per the follow-ups plan sequencing.

## Phase 13: Standard-Surface Background Authority
