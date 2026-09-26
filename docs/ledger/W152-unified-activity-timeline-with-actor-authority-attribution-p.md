<!-- Ledger fragment: extracted from TASKS.md at line 5570 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W152 - Unified activity timeline with actor/authority attribution (Planned - Paperclip borrow wave 3; spec Wave 3) (2026-09-26)

**Source:** Paperclip's activity log (every mutation with actor + entity + before/after), mapped onto the kernel transition log + run registry records via the existing History panel. One chronological feed: kernel transitions, run begin/review/finish, review verdicts, budget tier crossings, schedule fires — each row naming actor (operator/agent/system) and authority basis (kernel transition or authorization record).

**Acceptance criteria:**
- [ ] Every rendered row's actor/authority comes from the underlying record; missing attribution renders an explicit "unattributed" state (test — the UI never synthesizes attribution).
- [ ] Append-only: a test proves no feed mutation path exists.
- [ ] Retention wording matches the hub's actual persistence behavior (asserted in the same test).

**Residuals (cut):** CSV export, permission tiers, "responsible user" (single operator), Paperclip's "permanent record" claim (the panel copies the hub's actual retention verbatim).
