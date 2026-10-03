<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W179 — gate-2 credential binding on the open-source-pool family proxies

**Source:** issue #439 (W179, two-gate credential custody). W184 (`docs/EGRESS_CAPABILITY_AUDIT.md` §3a, `docs/SECURITY_ASSURANCE.md` S6) shipped the production gate-2 binding source for the single-origin lanes but deliberately EXCLUDED the W070a open-source-pool family proxies, on the stated ground that the family upstreams are vendor-specific and a single `WORKFLOW_ACP_UPSTREAM`-derived binding could only blanket-refuse their traffic. That exclusion left the vendor families with the policy tier and sinks but no second credential gate.

**Decision.** Wire gate 2 to the family proxies through the SAME `allowedEndpoints` source, but narrow per family against each vendor's OWN origin via `perFamilyCredentialBinding` (`src/integrations/egress-binding.ts`). This resolves W184's stated blocker directly: the binding is derived from `def.endpoint`'s origin, not the OpenRouter origin, so a matching definition scopes the family and a non-matching one is dropped rather than blanket-refusing. A family whose origin no definition binds is OMITTED, leaving its gate dark and byte-identical.

**The seam.** `CreateOpenModelMeteringPoolOptions.credentialEndpointsByFamily?: Partial<Record<ModelFamily, readonly CredentialEndpoint[]>>` (dark when absent; an empty array for a family matches nothing, fail closed). `src/integrations/acp-runtime.ts` composes it in the pool site from `perFamilyCredentialBinding(openSourcePoolFromEnv(), loadCredentialDefinitions())`.

**Honest boundary.** The family proxies inject a VENDOR key loaded through `src/integrations/open-model-keys.ts` (`OPEN_MODEL_KEY_ENV` / key files), a custody path SEPARATE from `CredentialDefinition.allowedEndpoints`. The binding scopes *where that key may go*; it is not an identity proof, and an operator who declares no vendor endpoint binding keeps the pre-W179 posture byte-identical. Docs updated in place: `docs/EGRESS_CAPABILITY_AUDIT.md` §3a production-activation paragraph and the `docs/SECURITY_ASSURANCE.md` S6 row now name the per-family narrowing instead of the exclusion, plus a new S6 row binds the family-boundary behavior.

**Verification.**
- `node --import tsx --test test/open-model-proxy.test.ts` — 16/16 pass (added: out-of-binding refusal never reaches the vendor upstream; a covering binding forwards).
- `node --import tsx --test test/egress-binding.test.ts` — added `perFamilyCredentialBinding` narrowing cases (vendor origin, no-leak of the OpenRouter binding, empty-when-unbound); suite green.
- `node --import tsx --test test/security-assurance.test.ts` — 7/7; every new/edited S6 row resolves to a real test title.
- `npm run lint`, `npm run typecheck` — exit 0.

**Residual.** The claim stays scoped to the supplied case: an operator with no vendor `allowedEndpoints` gets no family gate. The §5 direct-host bypass and the vendor-key custody path are unaffected.
