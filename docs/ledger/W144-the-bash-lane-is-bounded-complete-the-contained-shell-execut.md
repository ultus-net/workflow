<!-- Ledger fragment: extracted from TASKS.md at line 5392 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W144 - The /bash lane is bounded (Complete - the contained-shell execute takes a wall-clock cap: the backend kills the process group at the expiry and rejects with the named timeout error; the agent tool lane's posture untouched) (2026-09-25)

**Source:** the W142 wave's finding (c) — NO timeout anywhere in the
/bash chain (grep-verified across hub-http.ts, contained-shell-executor.ts,
linux-bwrap.ts); a hung command would hold the hub's executor
indefinitely. The operator's "solve this problem" direction.

**What landed:**
- `ContainedProcessRequest.timeoutMs` (optional): a bounded wall-clock
  execute at the containment contract level. The kill lives in the
  BACKEND (only it holds the child handle): both backends spawn
  DETACHED so the child leads a process group, arm a timer, and on
  expiry SIGKILL the group (ESRCH falls back to child.kill) — the
  review's P3 defense destroys the held stdio streams so `close` fires
  instead of waiting on the dead group's descriptors — and reject with
  `contained command timed out after Nms (process group SIGKILL):
  <partial output>`.
- The executor FORWARDS the option only (it never sees the child
  handle); the hub /bash route passes `bashTimeoutMs(process.env)` —
  DEFAULT_BASH_TIMEOUT_MS 120s, WORKFLOW_HUB_BASH_TIMEOUT_MS a positive
  integer CLAMPED to MAX_BASH_TIMEOUT_MS (3.6e6; an operator-explicit
  env cannot smuggle the unbounded lane back), garbage falls back to the
  default. shellExecutorFor gains the optional 5th param.
- The AGENT TOOL LANE is untouched: run-controller's own
  createContainedShellExecutor call passes no cap, pinned by the
  no-field assertion (the lane's unbounded posture is a separate queued
  decision); the streaming spawn() lane untouched (interactive ACP).
- Pins: the executor forwarding contract (test/
  contained-shell-timeout.test.ts — the cap reaches the backend as
  request.timeoutMs; no option → NO field; the unbounded guard), the env
  seam (test/bash-timeout-env.test.ts — the default, the override,
  garbage fallbacks, the clamp), both backends' kill pins
  (containment/platform — the kill lands at the cap, never at the
  sleep's full duration; the in-cap symmetry guard), and the live-hub
  e2e (test/e2e-hub-bash.test.ts — 750ms cap, `echo partial; sleep 30`
  → 500 with the named timeout error carrying the partial output, the
  hub stays alive and serves the next command, clean shutdown).

**Acceptance criteria:**
- [x] Red-first: with the six src files stashed, exactly the W144 pins
      are red (the forwarding pins, the env seam's import, the two
      backend kill pins, the e2e pin); green after: 39/39 across the
      five pin files; held-out hub-protocol + e2e-contained-shell +
      interactive-containment-cli 8/8; lint + typecheck exit 0.
- [x] Fresh-eyes review APPROVE (five axes; the kill-safety trace —
      detached + group kill + ESRCH fallback + the streaming lane
      untouched — verified; the three strengthening P3s applied
      post-review: the stdio-destroy defense, the clamp, the passthrough
      pin's message clause).

**Residuals (recorded, not fixed):** Number-parse laxity in the override
("0x10" → 16, " 750 " → 750 — bounded either way, cosmetic); the agent
tool lane keeps its unbounded posture (its own queued decision); the
wire shape on timeout is a 500 carrying the message (finding (a)'s
exit-code/representation gap remains its own item); the hung-command
lane can no longer exist to observe (finding (c) is closed, not
superseded).
