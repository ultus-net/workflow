# Hosting assessment: AZ Function vs Azure Container Apps vs stay-local

**Date:** 2026-09-30 · **Status:** decision-input assessment. **The decision
stays the operator's** (the issue's own framing: "Hosting assessment: AZ
Function vs Container Apps vs stay-local (operator decision)", GitHub issue
#140; the ledger criterion reads "Operator decision recorded before
implementation" — `docs/ledger/W093-serverless-hosting-option-for-the-control-plane-az-function-.md:38`).
Docs-only: no code, no infra, no bicep. Nothing here supersedes a recorded
claim; it evaluates the recorded machinery against the three options.

**Open decision it informs:** the W093/W096 ledger items (the pre-freeze
TASKS.md hosted-assessment blocks, "Phase 12/15 era" per the issue body) —
operator intent 2026-09-22 that the control plane "will likely run as an
Azure Function ... alongside the local daemon"
(`docs/ledger/W093-...md:4-6`), status "intent + constraints only. No design,
no claims" (`docs/ledger/W093-...md:8`).

**Recorded sources read before writing:** W093/W096 ledger fragments; the
deployment-instance split spec
(`docs/superpowers/specs/2026-09-26-deployment-instance-split.md`, esp. §5,
§6, §10); the publish workflow (`.github/workflows/publish-image.yml`); the
instance seed (`instances/azure/`: README, `azure-pipelines.yml`,
`verify-pin.sh`, `params.bicepparam`); the C0 probe record
(`infra/c0/README.md`); the remote-sandbox design spec
(`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`,
esp. §8, §10, §11); the protocol-planes plane map
(`docs/PROTOCOL_PLANES_2026-09-22.md`); `THREAT_MODEL.md` (trust zones,
loopback residual); the W156 secret-store seam
(`docs/ledger/W156-the-pluggable-secret-store-seam-key-vault-as-the-azure-end-state.md`);
`docs/CI.md` (tier D).

---

## 1. What the recorded machinery already decides (shared by every option)

Three recorded layers constrain any hosting choice before the operator
decides anything:

**1a. The publish/pin flow (open half) is option-independent.** A `v*` tag
push builds `images/control-plane/Dockerfile` and pushes to GHCR, then
records the pushed digest as a release asset and release note at the SAME
tag, from the SAME run that pushed the image
(`.github/workflows/publish-image.yml:80-90`; split spec §10 Q2: the record
"cannot exist before the image is pushed", so it is never a mutating file in
the tagged tree). The workflow fails closed at the download step if the
operator has not attached the qualified stock-opencode binary as a release
asset ("v2.0.10 is a dev-channel build not publicly fetchable";
`publish-image.yml:46-52`, comment block lines 5-10). Honest status: the
machinery is **NOT yet verified live**; "the first tagged run is the
verification" (`docs/CI.md:109`, tier D; W149 dated note,
`TASKS.md:5786-5790`). Every option below consumes or skips this same
machinery; none of them changes it.

**1b. The pin-verification flow (instance half) is option-independent.**
`instances/azure/verify-pin.sh` materializes the downloaded digest
expectation and compares it against the to-be-deployed reference BEFORE any
deploy step, refusing on mismatch or absence, never degrading to
deploy-anyway (`instances/azure/verify-pin.sh:25,34-46`; pipeline step 1
wiring `instances/azure/azure-pipelines.yml:47`; the expectation must be
DOWNLOADED from the release because a git checkout does not carry release
objects — `azure-pipelines.yml:41-45` TODO, `params.bicepparam:14`). It
verifies an image digest; it does not care where that image runs. What the
options DO change is the deploy step that follows it (step 2,
`azure-pipelines.yml:50-56`) and everything after the image is running.

**1c. The trust boundary today is loopback.** The hub binds loopback only
(`server.listen(0, "127.0.0.1")` — `src/integrations/hub-http.ts:176`); the
plane map rows: plane 3 is "loopback-only (`127.0.0.1`, ephemeral port,
discovery-file tokens)" with two credential classes, plane 3′ is the
UNcredentialed browser channel on `127.0.0.1`
(`docs/PROTOCOL_PLANES_2026-09-22.md:22-23`). The threat model's residual row
says it outright: "No authentication; exposing/reverse-proxying it beyond
loopback is unsupported" (`THREAT_MODEL.md:42`), and the trust-zone bullet
calls the current server "a loopback development surface, not an
authenticated remote control plane" (`THREAT_MODEL.md:16`). The B2
position: "an internal, loopback, credential-classed operational API is
safer than exposing a general-purpose ... surface", falsified only by a need
for third-party clients, with the standing instruction to re-read
THREAT_MODEL before any surface widening
(`docs/PROTOCOL_PLANES_2026-09-22.md:54-58`). Stay-local keeps this boundary
untouched; both hosted options widen it (section 6).

**1d. Credential custody has a recorded seam with a default that is local.**
`WORKFLOW_SECRET_STORE=keyring` (D-Bus keyring via secret-tool) is the
default; `azure-kv` (Key Vault REST via managed identity/IMDS, env-sourced
vault name, fail-closed at startup when the vault name is missing) is the
recorded Azure end-state (`docs/ledger/W156-...md:13-22` equivalent passage;
`src/integrations/secret-store.ts:9-23` throw paths). The instance-side
config for the azure-kv path (vault + managed-identity RBAC get/list on
secrets for the app identity) is recorded in the seed checklist
(`instances/azure/README.md:27-30`). C0 used the ACA-managed secret as a
probe shortcut only ("Key Vault deferred to C1" — `infra/c0/README.md:68`;
split spec §10 Q3). Consequence for the options: stay-local runs the
default keyring path; BOTH hosted options make the non-default azure-kv
branch the mandatory one, which is exactly what the seam was built for
(W156).

**1e. The C/P-track plan already awaits this decision, and its evidence is
ACA-shaped.** The 2026-09-25 spec defines C1 (Workflow behind the gateway:
hub + `opencode-server` daemon + gateway + broker in-container, posture
stays advisory — spec lines 153-156), C1.5 (Easy Auth edge probe against ACA
`authConfig` with `excludedPaths: /api/*` — lines 157-162), C2 (Azure Files
durability drill — lines 163-166), and the P-track job fleet (lines 168-182).
The issue states the C/P-track plan "awaits this decision" and that C0 is
live: "PR #128, `workflow-dev-cplane` in `workflow-dev-rg`, australiaeast,
probe 6/6 PASS incl. SSE through ingress", with "Always-on control plane
(minReplicas=1) cost explicitly accepted by the operator" (issue #140 body).
The recorded C0 evidence is Container Apps transport evidence: health, 401
rejection, SSE open, session create, activity round-trip, cleanup — six
PASS verdicts through external ingress (`infra/c0/README.md:3,75-80`) under
the pinned recipe (external ingress targetPort 4096, transport `http`
chunked, session affinity absent, minReplicas 1/maxReplicas 1, 0.5 vCPU /
1 GiB consumption — `infra/c0/README.md:59-73`).

---

## 2. Option A — Azure Function (host the control plane as a Function)

**Fit with the recorded machinery.** The open half (1a) survives unchanged:
Functions hosting still consumes the GHCR image, and `verify-pin.sh` still
verifies the digest before deploy. The instance half splits: pin
verification is reusable; the deploy step and every recorded live probe are
not. The C-track evidence and probe plan are written against Container Apps:
the pinned transport recipe is an ACA ingress recipe
(`infra/c0/README.md:59-73`), the C1.5 Easy Auth probe is written against
ACA `authConfig` (`2026-09-25 spec:157-162`), and the C1 topology is
container-shaped ("hub, opencode-server daemon, contained serve, and gateway
run in one container speaking loopback to each other — the container is the
boundary"; spec lines 247-253). A Functions deployment re-opens all of it.

**Cold-start/latency for the operator loop.** The operator loop is not
request-shaped: the TUI attach and the authority broker both ride a
long-lived SSE stream (the "load-bearing risk", spec lines 254-255), the
scheduler ticks periodically, and the RSI loop is long-lived. The W093
fragment already records the mismatch: "the RSI loop and scheduler tick are
long-lived/periodic — a consumption-based function needs durable-function or
timer-trigger shaping" (`docs/ledger/W093-...md:28-30`). Scale-to-zero
(erasing the always-on latency) is therefore not a free win: it converts the
operator loop into cold-start-per-turn plus a redesign (durable functions),
and staying always-on on Functions re-creates the always-on cost the
operator already accepted for ACA (issue #140) while adding a Functions
runtime layer between the operator and the container boundary. No recorded
source claims a Functions cost or latency advantage; the only recorded cost
decision is the ACA always-on posture (spec lines 224-229: "`minReplicas=1`
is the standing posture, not a default pending review").

**What it adds / invalidates.** Adds: a new trigger/runtime model over the
same image, plus re-recording of the C-track probes in a Functions shape
(no recorded probe plan exists for Functions). Invalidates (as written,
would need dated supersession notes per the honest-claims culture): the C0
pinned recipe's status as the qualified transport record (it is
ACA-specific), the C1.5 probe design, and the C1 "container is the boundary"
topology argument (spec lines 247-250) acquires a second platform layer
whose isolation story would have to be argued before anything real runs
(split spec §9: custody inside the work tenant "warrants a security-review
conversation before anything real runs").

**Security delta.** Same kind of ingress widening as ACA (public HTTPS in
front of a plane whose channels are loopback-credentialed today), plus an
additional runtime/trigger layer that is not part of the recorded trust
argument. The five re-opened surfaces recorded in W093 all apply
(`docs/ledger/W093-...md:16-30`): auth becomes mandatory off-loopback; the
plane-3′ uncredentialed browser channel "cannot exist remotely and needs a
credentialed replacement or explicit scope removal"; agent transports (stdio
ACP) stay local or ride the advisory remote-ACP bridge; containment (bwrap
is "a local-runtime primitive"; `/bash` and run gates need a runtime
decision); durable state (local JSON stores need a durable remote store
decision). Containment applies equally to both hosted options (both run the
same image), so it is not a differentiator; the Functions-specific delta is
the unrecorded platform layer and the absence of any recorded probe
evidence.

**Cost shape.** Always-on plan class (scale-to-zero is incompatible with the
operator loop without the durable-function redesign), i.e. the same
always-on billing class as ACA plus the Functions plan model. Work pays
hosting (split spec §1). The honesty rule applies: no recorded basis to
claim savings, and the operator's recorded acceptance is tied to ACA
minReplicas=1 (issue #140).

**Operational burden.** Everything ACA requires below (instance repo,
pipeline, approvals, Key Vault config, pin check) plus Functions-specific
infrastructure, pipeline steps, and probe re-recording that exist nowhere in
the recorded docs. Highest design debt of the three options.

---

## 3. Option B — Azure Container Apps

**Fit with the recorded machinery.** This is the option the recorded
machinery already targets. The publish/pin flow (1a/1b) was designed for
exactly this consumption: image by digest into an instance whose pipeline
materializes the release-asset expectation and refuses to deploy on
mismatch (split spec §5, §10 Q2; `instances/azure/README.md:15-21`
consumes/provides table). The C-track is ACA-native end to end (C0 done,
C1/C1.5/C2 defined — spec lines 147-166). The seed's two-checkout pipeline
pins the open tag and never a moving ref
(`azure-pipelines.yml:9-15`, `params.bicepparam:9-14`).

**What it adds / invalidates.** Adds: execution of the recorded C-track.
The ingress widening over the loopback boundary is the real cost, and the
recorded mitigations are already specified as three non-conflatable gates:
Easy Auth answers *who can reach the plane at all*; the gateway
route-class matrix + credential split answers *which routes/credentials may
pass*; `WorkflowApplication.authorize` answers *may this tool call mutate*
(spec lines 263-267). Recorded accepted trade-offs: the browser double gate
(Entra cookie + gateway basic auth) accepted initially; teaching the gateway
to trust `X-MS-CLIENT-PRINCIPAL` is a header-spoofing footgun, safe only
while the exclusion list stays exactly `/api/*` (spec lines 272-276); the
gateway becomes the single front door for UI shells and all API lanes
(spec lines 280-283); remote-facing MCP stays out of scope because ACA Easy
Auth does not emit MCP Protected Resource Metadata
(microsoft/azure-container-apps #1736, spec lines 304-305). Invalidates:
nothing recorded. What needs a dated note (not a rewrite) is the THREAT_MODEL
loopback residual (`THREAT_MODEL.md:16,42`): when C1 lands, those lines
describe the local surfaces and must gain a dated widening note for the
hosted instance, per the honest-claims culture.

**Cold-start/latency.** Solved by the recorded posture: always-on
`minReplicas=1` is the standing, operator-accepted posture (spec lines
224-229; issue #140). The residual unreachability case (revision restart,
manual scale-in, network) is already designed for: the launcher probes
gateway health and classifies asleep (auto-wake via Management API PATCH
`minReplicas` 0→1) vs broken (report honestly, never a doomed wake) vs no
`az` session (state exactly why) — spec lines 230-246. SSE through ingress,
the load-bearing risk, is the one thing C0 verified live (6/6 PASS
including the stream through external ingress — `infra/c0/README.md:75-80`);
the optional idle-survival gate exists for the 4-minute ingress idle window
(`infra/c0/README.md:41-52`).

**Security delta.** The largest of the three options by construction (it is
the only one that actually exposes ingress), but every delta has a recorded
countermeasure or an explicit out-of-scope marker: credential custody moves
to Key Vault refs + managed identity (W156; `instances/azure/README.md:27-30`),
matching the THREAT_MODEL custody rule that production stores fail closed
when the backing credential service is unavailable (`THREAT_MODEL.md`, trust
zones); the vault + MI RBAC is instance-side config per the one-way
dependency rule (split spec §3). Containment posture does not silently
widen: C1's posture stays advisory (spec line 156), and `enforced` claims
still wait on the P2 permission-loop probe over public ingress (spec lines
163-166).

**Cost shape.** Always-on consumption plan, 0.5 vCPU / 1 GiB standing
posture, explicitly accepted by the operator (issue #140;
`infra/c0/README.md:66-67`). The remaining cost question is recorded and
narrowed: GHCR direct pull vs an ACR mirror in the work tenant (split spec
§10 Q1), instance-side, gates nothing open-side.

**Operational burden.** The seed's checklist is the recorded burden:
service connection, registry + pull authorization, region/RG/app params,
Key Vault refs + MI RBAC, environment with approvals/checks, pin-verification
wiring, Boards-linked PRs citing the consumed open tag
(`instances/azure/README.md:15-30`, `:32-35` rules). Plus the W148 strip is
gated on this repo existing ("gated on the work AzDO repo existing",
`TASKS.md:31-33`; split spec §11).

---

## 4. Option C — stay-local

**Fit with the recorded machinery.** Zero deltas. The local-first guarantee
is a permanent recorded requirement: "the instance is additive, and the core
gains no dependency on it. Losing work access reverts to local use, never to
breakage" (split spec §6). The hub keeps its loopback binding
(`src/integrations/hub-http.ts:176`), the threat-model rows keep their
truth (`THREAT_MODEL.md:16,42`), and credential custody stays on the keyring
default (W156). The plane map's local topology (stdio ACP agents, bwrap
containment, local JSON stores) is the recorded current truth, not a
limitation to be argued away.

**What it adds / invalidates.** Adds: nothing. Invalidates: nothing — the
publish machinery stays adopter-facing and coherent (open-side adopters can
still consume the image; W149), and the seed stays a generic template
("it stays generic so any deployment instance can start from it",
`instances/azure/README.md:5-7`). The W093/W096 assessment criterion closes
with "stay-local chosen"; W148's strip stays gated (the work instance repo
may never exist, which the split spec already tolerates: the instance is
additive, §6).

**Security delta.** None vs today.

**Cold-start/latency.** None (in-process). The cost is the recorded
motivation for hosting going unrealized: "the laptop stops being the
bottleneck — builds, test runs, indexing, and many concurrent agent streams
run on Azure compute while the TUI stays a thin client" (spec lines 219-222).
Stay-local keeps the laptop as the bottleneck by choice.

**Cost shape.** No Azure hosting spend; work pays nothing. The recorded
work-side arrangement (work pays hosting and inference, tools stay the
operator's — split spec §1) goes unrealized. The exit path recorded for the
instance ("re-pointing the same params at a personal subscription ... is a
param change, not a rebuild", split spec §3) does not apply because nothing
is deployed.

**Operational burden.** The existing local discipline only (hub daemon,
discovery-file tokens, guard, review control plane). The lowest-burden
option and the safest; its only recorded downside is the unrealized
motivation above.

---

## 5. Security deltas vs the recorded loopback boundary (per option)

| Surface | Stay-local | Container Apps | AZ Function |
| --- | --- | --- | --- |
| Hub binding | `127.0.0.1` unchanged (`src/integrations/hub-http.ts:176`) | Gateway is the single public front door; hub stays loopback-internal to the container (spec lines 247-250, 280-283) | Same container-internal idea, but behind the Functions trigger/runtime layer (not recorded anywhere) |
| Plane 3 credential classes | Operator/verifier bearer tokens, loopback + discovery-file only (`docs/PROTOCOL_PLANES_2026-09-22.md:22`) | Same credential classes over public ingress; Easy Auth + route-class matrix layered in front (spec lines 263-267); gateway credential split per W071 mapped 1:1 onto remote operation (spec lines 251-253) | Same widening as ACA, plus re-derivation of the gate layering in a Functions shape (unrecorded) |
| Plane 3′ browser channel | Uncredentialed loopback posture stands (`THREAT_MODEL.md:16,42`; `PROTOCOL_PLANES:23`) | Cannot exist remotely as recorded; needs the credentialed replacement or explicit scope removal W093 already requires (`docs/ledger/W093-...md:16-19`); the recorded replacement is Easy Auth redirect for browser shells with `/api/*` excluded (spec lines 268-276) | Same as ACA, re-designed |
| Credential custody | keyring default (W156) | azure-kv mandatory: Key Vault refs + MI RBAC, instance-side config (`instances/azure/README.md:27-30`; W156); fail-closed rule honored (`THREAT_MODEL.md` custody bullet) | azure-kv mandatory likewise (MI works on Functions), but the surrounding runtime is unrecorded |
| Agent transports | stdio ACP, bwrap containment (local primitives) | stdio stays in-container loopback-internal; remote attach rides the gateway; posture advisory until probes pass (spec lines 153-156) | Same question as ACA; additionally the trigger model has no recorded transport story |
| Durable state | local JSON stores, writer-exclusion assumptions (`THREAT_MODEL.md` persistence bullet) | Azure Files volume so state survives the replica; drain/resume is the C2 drill, not an assumption (spec lines 260-262) | Needs the same decision, unrecorded |
| Trust-zone honesty duties | none pending | THREAT_MODEL loopback rows need dated widening notes at C1 (append-only, never rewrite) | Same, plus new rows for the Functions layer before anything runs (split spec §9: security-review conversation first) |

---

## 6. Recommendation matrix

One line per axis, grounded in the sections above:

| Axis | AZ Function | Container Apps | Stay-local |
| --- | --- | --- | --- |
| Recorded live evidence for the option | none (no recorded probe plan) | C0 6/6 PASS through external ingress (`infra/c0/README.md:75-80`) | the recorded current truth |
| Publish/pin machinery fit | survives (image consumed by digest) | designed for exactly this consumption (split spec §5, §10 Q2) | unused by the control plane, stays adopter-facing |
| Probe-plan fit | C-track probes must be re-designed (C1.5 is ACA `authConfig`, spec lines 157-162) | recorded and awaiting execution (spec lines 147-166) | not applicable |
| Operator-loop latency | scale-to-zero breaks the loop; always-on re-creates ACA cost plus a runtime layer (W093:28-30) | always-on `minReplicas=1`, accepted; launcher plane-awareness covers unreachability (spec lines 224-246) | in-process, none |
| Security delta vs loopback | ingress widening + unrecorded platform layer | ingress widening with recorded three-gate mitigation and explicit out-of-scope markers (spec lines 263-283, 304-305) | none (`THREAT_MODEL.md:42` unchanged) |
| Credential custody | azure-kv mandatory (unrecorded surroundings) | azure-kv mandatory, recorded instance-side config (W156; `instances/azure/README.md:27-30`) | keyring default (W156) |
| Cost shape | always-on plan class; no recorded basis for savings; operator's accepted cost is ACA-tied (issue #140) | always-on consumption 0.5 vCPU/1 GiB, explicitly accepted (issue #140) | no hosting spend; unrealized work-side arrangement (split spec §1) |
| Operational burden | ACA's burden plus Functions-specific design + probe re-recording | the seed's checklist (recorded); W148 strip gated on this repo (`TASKS.md:31-33`) | the existing local discipline only |
| Adds / invalidates | adds a new runtime model; invalidates-as-written the C-track probe plan and C0's recipe status | adds execution of the recorded plan; invalidates nothing | adds nothing; invalidates nothing; leaves the recorded hosting motivation unrealized |

---

## 7. Recommendation (decision-input only)

**Recommendation: Azure Container Apps** (option B), on the recorded
evidence alone:

- It is the only option with live recorded transport evidence for the exact
  load-bearing risk (SSE through ingress: C0 6/6 PASS,
  `infra/c0/README.md:75-80`).
- It is the only option the recorded machinery already targets: the split
  spec's consumption model, the seed pipeline, the verify-pin wiring, the
  C/P-track milestones, and the accepted always-on cost posture all name
  Container Apps (split spec §5/§10; `instances/azure/*`; spec lines
  147-166, 224-229; issue #140).
- Its security widening is the one with recorded countermeasures already
  specified as probe-gated gates rather than hopes (spec lines 263-267),
  with the residual honesty duties (dated THREAT_MODEL notes at C1,
  remote-facing MCP out of scope) already stated (spec lines 304-305).

**Trade-offs, stated:** the real cost of B is the ingress widening of the
loopback trust boundary; every mitigation is currently a recorded plan, and
the honest-claims rules mean posture stays advisory until each gate's probe
passes (C1, C1.5, C2, P2). Option A is not disqualified on security (the
ingress delta is the same kind) but on evidence and fit: it carries the
recorded operator-loop mismatch (long-lived SSE + scheduler vs
request-scoped triggers, W093:28-30), no recorded probe plan, and the
highest unrecorded design debt, for no recorded cost or latency advantage.
Option C is the safest and cheapest and remains the permanent fallback the
split spec guarantees (§6); it simply leaves the recorded motivation
(spec lines 219-222) and the work-side arrangement (§1) unrealized.

**Sequencing note regardless of the decision:** the publish machinery's
first live tagged run is the prerequisite for any hosted option that
consumes the image, and it is currently unverified (W149: "NOT yet verified
live" — `publish-image.yml` header comment; `docs/CI.md:109`;
`TASKS.md:5786-5787`). If the operator chooses stay-local, W149 remains
adopter-facing work; if either hosted option is chosen, the first tagged run
plus the seed checklist are the next gates.

**The decision is the operator's.** The issue is titled "Hosting assessment:
AZ Function vs Container Apps vs stay-local (operator decision)", and the
ledger criterion says "Operator decision recorded before implementation"
(`docs/ledger/W093-...md:38`). This document records the assessment and a
recommendation; it records no decision.