<!-- Ledger fragment: opened 2026-09-30 as the P14 record (issue #293). Write-once — append dated supersession notes, never rewrite. -->

### P14 — cache-marker opt-in granularity (Landed - the per-family opt-in over an unchanged all-keyed boolean; the activation stays dark behind the unrun P8 vendor probes) (2026-09-30)

**Source:** `docs/PARKED_AND_LIMITATIONS.md` row P14 — "the composer flag covers all keyed families at once — coarser than per-vendor-pool; per-family granularity queued". W109 gap 6; GitHub issue #293. The P8 dependency is explicit on the row: the live per-vendor anthropic `cache_control` probes are UNRUN, so the opt-in must stay dark by default.

**What landed:**

- **`CacheMarkerOptIn = boolean | { readonly [family: string]: boolean }`** (`src/integrations/model-profile.ts`): the additive per-family shape. The chosen shape because the config surface (the `CreateOpenModelMeteringPoolOptions.cacheMarkers` flag, and the `ModelProfileInput.cacheMarkers` it threads to each family profile) is already one value shared across keyed families; a map keyed by `ModelFamily` narrows it without adding a second option. `true` keeps meaning ALL keyed families (byte-unchanged); a map opts in only the families whose entry is `true`; a family omitted from the map (or set `false`, or an empty map) is OFF — fail-closed/dark, never ON-by-default.
- **The marker application consults the family.** `applyCacheMarkers` reads `cacheMarkersEnabled(profile.cacheMarkers, profile.family)` — a pure exported resolver — before the existing anthropic-wire gate. The composer needed no per-family branching: the one map rides onto each family's profile and the pass resolves it against that profile's own `family`.
- **Default behavior byte-unchanged.** With no option no markers are added (`undefined` is dark); with `cacheMarkers: true` all keyed anthropic-wire families are marked exactly as before. The `open-model-proxy` composition line is untouched (the option value is passed through as-is), and `ModelProfile.cacheMarkers` still resolves only when supplied — absent stays absent.
- **`docs/PARKED_AND_LIMITATIONS.md` row P14** got the dated append-only note (granularity landed; the P8 probe gate for turning any family ON stands).

**Evidence:** red-first pins captured verbatim against unmodified src, then green after implementation.

- Verbatim reds (the map was not yet honored — a map is not `=== true`, so no family was marked):
  - `test/model-profile.test.ts` → `not ok 14 - P14: a per-family map opts one family in and an omitted family stays dark` / `name: 'AssertionError'` / `expected: true` / `actual: false` (the opted-in family was left unmarked).
  - `test/open-model-proxy.test.ts` → `not ok 7 - P14: the pool's per-family cacheMarkers map marks only the opted-in family` / `name: 'AssertionError'`.
- Green pins:
  - `test/model-profile.test.ts`: per-family map on/off (listed family marked; omitted family untouched); explicit `false` and empty map all-dark; the boolean still marks deepseek/glm/kimi; the default stays dark; the anthropic-wire gate unchanged under a map.
  - `test/open-model-proxy.test.ts`: one map shared across two keyed anthropic-wire families marks only the opted-in deepseek family and leaves the omitted glm family dark through the governed pipeline.
  - Green counts: `node --import tsx --test test/model-profile.test.ts` → **18/18 pass, 0 fail**; `node --import tsx --test test/open-model-proxy.test.ts` → **9/9 pass, 0 fail**.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Residuals:** the P8 gate is unchanged and load-bearing — which families (if any) actually accept the Messages-schema `cache_control` markers is **unprobed**, so no production composition enables a family; the operator's per-vendor probe verdicts are what flip a family `true`. The marker pass still marks only the static composition head; the per-turn breakpoint policy is P13 (unchanged here).
