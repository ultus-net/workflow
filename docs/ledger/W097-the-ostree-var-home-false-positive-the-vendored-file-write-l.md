<!-- Ledger fragment: extracted from TASKS.md at line 2389 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W097 - The ostree /var-home false positive: the vendored file-write lane was dead on the operator host (2026-09-23; re-landed on the v2 branch after the merged-branch push block)

**Objective:** the vendored checkProtectedPath system rule (the /etc//usr//var prefix test) denied EVERY write on ostree hosts: /home is a symlink to /var/home, so every home-anchored path - including WORKSPACE-RELATIVE file_writes whose lexical candidate resolves into the home mount - realpaths under /var and was denied as a protected-system-or-credential-path. Live-probed before the fix: checkProtectedPath(src/a.ts, cwd) on the operator workspace returned the deny (the entire W089 file-write lane was dead-on-arrival on this host); the W089 review had caught only the absolute-path instance.

**Where:** mcp-toolbox/apps/workflow-guard-mcp/src/path-policy.ts (the checkProtectedPath candidate loop).

**Acceptance criteria:**
- [x] The user real home (realpath-resolved) is classified as user space: home-anchored absolute writes and workspace-relative writes return undefined (allow); the /etc//usr//var prefixes no longer fire for home-covered candidates.
- [x] Genuine system paths stay protected: /var/log, /var/lib, /etc, /usr still deny (they are not under the real home).
- [x] Credential rules still fire inside the home: .ssh and secret-name rules unchanged (credentials live in the home).
- [x] Verifier: W097 pins RED against the unmodified tree (52 pass/1 fail - exactly the user-home test; the genuine-/var and credential tests green pre-change as they assert existing protection), GREEN after the fix (62/0 across policy+mcp+redirect); guard typecheck OK; dist rebuilt and the LIVE probe re-run post-fix (home-abs: undefined; ws-relative: undefined; var-log: protected; ssh: protected); repo lint/typecheck exit 0.
- [ ] Queued (one change per iteration): the ask channel on the other four seats, the plane-3-prime pending-ask surface, daemon-level end-to-end ask pin, G2 part 2 (trustedRole), G5 branch-exit pins, G4 matched-surface field, dist-freshness pin (RESOLVED 2026-09-24 in W120 — `guardDistIsStale` + the runtime fail-closed throw + the test's self-healing rebuild; see the park file's P6), npm pack verifier debt (human-gated).
