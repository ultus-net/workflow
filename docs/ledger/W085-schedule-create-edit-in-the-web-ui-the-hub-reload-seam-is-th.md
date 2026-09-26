<!-- Ledger fragment: extracted from TASKS.md at line 1819 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W085 - Schedule create/edit in the web UI (the hub reload seam is the live registry)

**Objective:** Complete the Schedules page's operator surface: create and edit
schedules from the browser through the existing hub proxy. The original idea
of a "hub reload seam" is already solved by main's live schedule registry
(W074: `createScheduleRegistry` reads the table live, so `POST /schedule/save`
takes effect on the very next tick without a hub restart) — what is missing is
purely the affordance: the Schedules page renders pause/resume and delete but
no create/edit form, and its empty state points the operator at hand-editing
the table file.

**Depends on:** main's hub proxy (`/api/schedules/save` upsert-by-id with
field stripping, pinned in `test/web-operator-surfaces.test.ts`); no hub
change.

**Acceptance criteria:**
- [x] The Schedules page offers a create form (id, title, cron, prompt,
      workspace, review requirement) and per-schedule edit that prefills the
      form; editing preserves advanced fields (budget, taskClass, off-peak)
      by sending the full schedule entry through the same save proxy.
      (**Verified 2026-09-21** against the as-built code: the create/edit form
      (`src/ui/webapp/schedules-view.tsx`) upserts through
      `POST /api/schedules/save` with the full entry, so the hub's
      ScheduleMeta advanced fields survive edit round-trips.)
- [x] Save failures surface the hub's validation message verbatim (e.g. an
      invalid cron) — never a silent failure or a fabricated success.
      (**Verified 2026-09-21**: `onSaveSchedule` resolves the hub proxy's
      error message and the form renders it in a `role="alert"` slot.)
- [x] The pause/resume toggle and delete keep their existing semantics; run
      and loop start stay CLI-only with the page saying so. (**Verified
      2026-09-21**: pause/resume/delete ride the existing hub-proxy routes
      unchanged, and the page states "run-now and loop start are CLI-only —
      they require the verifier credential, never the browser token".)
- [x] SSR pins for the form affordances; the save-proxy endpoint tests keep
      passing unchanged (no server change); typecheck and lint clean.
      (**Verified 2026-09-21**: the W085 pins in `test/webapp-surface.test.ts`
      (create/edit affordances, colliding-id refusal before the save, per-
      schedule edit) and `test/web-operator-surfaces.test.ts` (save proxy)
      green; typecheck and lint clean. The slice had landed via
      `feat/schedule-create-edit` (PR #62) with its ledger boxes unticked —
      this pass reconciles the ledger to the shipped, tested implementation.)
