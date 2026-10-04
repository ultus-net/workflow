<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W182 — operator approval on egress deny via hub-scoped durable revisions

**Source:** issue #442 (W182, NVIDIA adoption Wave A7). W180's fail-closed
policy tier could refuse a request with `no_matching_rule`, but there was no path
for an operator to approve the denied function. W182 adds the ask-hold:
`docs/HUB_PROTOCOL.md` (`POST /egress/pending`, `POST /egress/answer`).

**Decision.** PR #454 (`1c207304`) lands a hub-scoped durable egress-policy
revision store in `src/integrations/egress-policy-revisions.ts`, plus the two hub
routes (`src/integrations/hub-http.ts`, `src/cli/hub.ts`):
- `POST /egress/pending` returns `{ generation, pending[], revisions[] }`.
  Parked proposals carry only value-free destination facts (host, port, method,
  pathname) plus an `approvable` flag (false for a credential-custody refusal).
- `POST /egress/answer` records `{ requestId, decision }`. An `allow`
  **re-checks current policy + provider bindings at merge time** and merges a
  durable revision (`{ status: "merged", revision }`); a policy or provider
  change since the park invalidates it (`{ status: "invalidated", reason }`,
  nothing merged); a `deny` returns `{ status: "denied" }`; an approval of a
  parked credential-custody refusal returns the structured
  `409 { status: "not-approvable" }`. An unknown/stale id is a client fault
  (404).

**No-stale-approval discipline.** Revisions are durable and reset-on-recreate;
the store's fingerprint reads its LIVE composed `policyVersion`, so a merge
between ask and answer invalidates the older park in-process. The provider
digest is resolved at hub start, so a credential change invalidates across a
restart.

**Honest boundary.** Approval machinery is **not an enforcement claim**: a merged
revision is a durable record the proxy may consult, never a guarantee. A
credential-custody refusal (foreign credential, endpoint mismatch) is never
operator-approvable by an egress rule.

**Verification.**
- `node --import tsx --test test/egress-policy-revisions.test.ts` — the durable
  revision store, reset-on-recreate, and no-stale-approval re-check.
- `node --import tsx --test test/hub-egress-approvals.test.ts` — the two routes,
  the merge/invalidate/deny/not-approvable outcomes, and the 404 stale-id path.
- `test/model-usage-proxy.test.ts` — the shared `onEgressDenied` event.
