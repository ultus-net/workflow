<!-- Ledger fragment: extracted from TASKS.md at line 5055 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W138 - The control-plane hidden-Unicode strip at the prompt seat (Complete - the named-class sanitize covers every prompt crossing WorkflowCodingSession.submit, and the web transcript shows what the agent receives) (2026-09-25)

**Source:** the operator's base-loop direction ("add something to the
control plane that strips out hidden unicode characters — help prevent
prompt injection"). THREAT_MODEL item 2 records the injection-pressure
class as a residual (reviewer/candidate lanes read agent-authored text);
no strip existed anywhere (greps for unicode/bidi/zero-width/homoglyph
across docs+src+test: empty before this item).

**What landed:**
- `src/application/text-hygiene.ts` — `sanitizeControlPlaneText`: a
  NAMED-CLASS denylist strip (control = C0 minus tab/newline/CR + DEL +
  C1; bidi = U+061C/200E/200F/202A-202E/2066-2069; zero-width = U+200B/
  2060/FEFF; tag = U+E0000-E007F; noncharacters = U+FDD0-FDEF + every
  plane's xxFFFE/xxFFFF) returning EVERY hit (kind + code point) so a
  surface can show what was removed. Idempotent, allocation-local, zero
  imports.
- The seat: `WorkflowCodingSession.submit` sanitizes BEFORE the
  queue/turn (the queue holds clean text) — every prompt crosses it
  (web channel, TUI, hub turn lanes hub.ts:143/219/300, the reviewer
  lane hub-run-gates.ts:58), so the THREAT_MODEL item-2 class is
  covered once. `SessionChannel.submit` sanitizes BEFORE storing the
  transcript item — the operator's transcript shows exactly what the
  agent receives, never a raw projection of stripped text.
- Pins: `test/text-hygiene.test.ts` (9 — per-class strip, the preserved
  classes byte-for-byte, the emoji-ZWJ overstrip guard, idempotence, hit
  shapes) + one web behavioral pin in `test/web.test.ts` (POST
  /api/prompt with one hit from every named class → the DRIVER receives
  the sanitized text AND the transcript item matches it).

**Acceptance criteria:**
- [x] Red-first: with only the two src changes stashed, exactly ONE pin
      is red (the W138 web pin — the raw payload with bidi/zero-width/
      tag/control/noncharacter chars reached the driver verbatim);
      green after: 36/36 (9 + 27).
- [x] Held-out submit consumers 27/27 (coding-session-queue,
      session-port, driver-registry, error-surfacing); lint + typecheck
      exit 0.
- [x] Fresh-eyes review APPROVE (five axes named; the class table
      verified complete; seat universality verified across five
      surfaces; kernel purity clean).

**Residuals (recorded, not fixed):** (i) the empty-prompt
validation-order gap — `isPromptRequest`'s trim catches U+FEFF but not
bidi/ZWSP/U+2060, so an all-invisible prompt passes the route, sanitizes
to "" at the seat, and runs an EMPTY turn (pre-change the same input ran
a turn carrying hidden text, so the change is fail-restrictive; the
queued fix is a sanitized-emptiness recheck); (ii) the strip's hits are
computed but never surfaced (silent mutation from the operator's view —
a strip notice is a queued UX decision); (iii) the TUI's Ctrl+E markdown
export writes the raw composer text (tui.tsx:599-607) — export parity
queued; (iv) the honest boundary of the denylist itself: ZWNJ/ZWJ and
variation selectors are PRESERVED (load-bearing for scripts/emoji) and
can still smuggle low-bandwidth data, and unlisted future glyphs pass —
a strict mode could queue; (v) the TUI composer echo/promptHistory keeps
the operator's raw text (their own input, not an agent-state projection).
