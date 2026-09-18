# Chat UI Research 2026 — Basis for the Web/TUI Improvement Pass

Date: 2026-09-17. Status: research record + implementation basis for branch
`feat/web-ui-chat-parity`.

Method: four parallel research passes over official vendor documentation,
changelogs, release notes, protocol specs, and repository READMEs, all fetched
2026-09-17; a live CDP audit of the Workflow browser UI against a scripted
fake-agent session (DOM/AX-tree extraction, computed styles, WCAG contrast
math, four viewport widths); and a gap analysis against
`docs/web-ui-feature-tiers.md` (2026-09-15). Claims below carry their source.
Login-walled surfaces (chatgpt.com UI, claude.ai UI, grok.com) were verified
through their public help centers and release notes instead; unverified items
are flagged.

## 1. Consumer chat UIs (ChatGPT, Claude, Gemini, Perplexity, Grok, Copilot)

Key 2025–2026 shifts that matter for an operator console:

- **Model + effort + mode live in the composer.** ChatGPT simplified its
  picker to Instant/Thinking/Pro with effort Medium→Extra High and a thinking
  slider (help.openai.com release notes, Jun–Sep 2026). Claude puts "which
  model, how much effort, and whether it uses thinking" in one menu next to
  the send button, marking the recommended level "Default"
  (support.claude.com/articles/8664678). Grok 4.5/4.6 expose low→xhigh
  effort (docs.x.ai release notes). Workflow already follows this pattern
  via ACP `configOptions`; the gap is rendering, not plumbing.
- **Thinking is displayed, not hidden** — Claude renders it in an expandable
  section; ChatGPT shows an upfront plan you can steer mid-response; Gemini
  brands "Extended Thinking" (I/O 2026). Collapsed-by-default is the norm.
- **Canvas/artifacts are diverging**: Claude keeps a right-of-chat artifact
  window with versions; ChatGPT is retiring Canvas for its newest models in
  favor of in-chat writing/code blocks (Jun 2026). In-chat rich blocks are the
  direction; side panels remain for substantial artifacts.
- **Permission UX converged on "allow low-risk, ask for consequential
  actions"** — Gemini Spark and Copilot Tasks use near-identical language;
  Perplexity surfaces confirmations *inside the input box*; Claude in Chrome
  added "Follow a plan" (approve once, then autonomous within the plan).
  Cursor deprecated per-command "Ask Every Time" in May 2026 in favor of
  sandbox-by-default + auto-review. Prompt-by-prompt modal approval is out of
  fashion; scoped once/session/always choices remain the vocabulary.
- **Forking/branching is a navigation primitive** (ChatGPT "Branch in new
  chat", Nov 2025; Perplexity thread forking, Jun 2026).
- **Proactive digests and scheduled tasks** are table stakes for agent
  products (ChatGPT Work, Claude Cowork, Gemini Spark, Perplexity Computer,
  Copilot Tasks, Grok Bot — all 2026 launches of "an agent with its own
  computer").
- **Visual trends**: Google's "Neural Expressive" redesign (fluid animation,
  vibrant color, new typography — I/O 2026); dark-first brand-tinted palettes
  (Perplexity near-black + teal `#35BDC8`); explicit light/dark/system modes
  (Claude appearance settings, Mar 2026); accessibility font options
  (Claude "Dyslexic Friendly"); prose set in humanist typefaces with
  monospace reserved for code. Playful loading states (ChatGPT image-gen
  Snake game) and character presence (Copilot Mico) mark a turn away from
  sterile minimalism.

## 2. OSS / self-hostable chat UIs (LobeChat, LibreChat, Open WebUI)

- **LibreChat v0.8.x** has the deepest agent UX: Activity Groups
  (AI-generated collapsible headers over reasoning+tool runs), live
  reasoning labels, Ask-User forms, tool approval gates with checkpointed
  resumption, quote-excerpt context, fork/branch, Meilisearch across
  messages, resumable streams, artifacts with self-hostable Sandpack
  (docs.librechat.ai). Its 2026 roadmap names "Tool UI refresh" as a Q2
  focus — the whole market is polishing tool-call rendering.
- **LobeChat/lobehub** pivoted to an agent-collaboration platform (agent
  @-mentions, marketplaces incl. SKILL.md skills, multi-agent groups,
  goal/task/acceptance flows, IM gateways; github.com/lobehub/lobehub).
  Three-layer message architecture (RFC 142) and white-box editable memory
  (RFC 144/146) are its structural contributions.
- **Open WebUI** (v0.11.x, 152k★): multi-model parallel-column compare,
  folders-as-projects, Notes with in-place "AI Enhance", Channels with
  @model tagging, native MCP via streamable HTTP, Model Arena/ELO
  (docs.openwebui.com). Strongest on multi-model comparison surfaces.

## 3. Coding-agent UIs (Cursor, Zed, Devin/Cognition, Cline, Codex, AionUi, ACP)

The competitive set for Workflow's operator console:

- **Tool-call cards are the unit of agent-state rendering** — ACP v1 encodes
  `kind` (read/edit/…/think) and `status` (pending/in_progress/completed/
  failed) explicitly "so Clients choose appropriate icons"
  (agentclientprotocol.com/protocol/v1/tool-calls). Zed, Cursor, Codex, and
  acp-ui all render typed cards with icons and live status.
- **Diffs are first-class**: Zed made split diffs the default (Feb 2026) on a
  multibuffer that survives thousands of changed files; Codex's review pane
  scopes Unstaged/Staged/Commit/Branch/Last-turn with per-hunk
  stage/unstage/revert; Devin Review groups and explains hunks with severity
  colors (Jan 2026). At minimum, unified diffs must render with +/- coloring,
  not as monochrome text.
- **Checkpoints/restore on every edit or message** (Cursor, Zed, Cline,
  Codex "last-turn"); Claude Code's rewind menu (code-only /
  conversation-only / both / summarize-from-here) is the granularity benchmark.
- **Queue + steering**: Cursor queues by default, Enter=queue, ⌘⏎=send-now,
  "steer" delivers at the next tool-call boundary; Zed mirrors it with a
  per-message Steer toggle. "Interrupt at tool boundaries, never mid-action"
  is the converged model (both shipped Aug 2026 changelogs).
- **Context transparency**: Cursor's context ring + per-category breakdown
  tray is the leader for "where did my context go"; Zed shows tokens next to
  the profile selector with auto-compaction notices.
- **acp-ui** (reference client) ships a Traffic Monitor that inspects raw
  JSON-RPC — protocol debuggability no commercial product exposes.
- **Codex desktop** stamps the composer with combined model+effort ("5.6 Sol
  Extra High") and offers scoped review surfaces; its read-only share
  snapshots redact secrets (2026).

## 4. Terminal chat UIs (OpenCode, Crush, Claude Code, Gemini CLI, Aider, Cline CLI)

Conclusions that respect `DESIGN.md` (the runnable TUI is Cline 3.0.61 under
a bounded patch; its interaction model is preserved, not redesigned):

- 2026 TUI table stakes: `/commands` + `@`-mentions + `!` shell; plan mode on
  Tab/Shift+Tab; permission prompts with once/always(pattern)/reject; session
  resume + compaction + token/cost meters; terminal-adaptive theming from
  OSC-11 background sampling; mouse support with an off switch. OpenCode
  `system` theme (grayscale generated from terminal bg + ANSI slots, `"none"`
  inheritance) and Gemini CLI ANSI themes are the terminal-palette-respect
  benchmarks; Workflow's TUI_INTEGRATION.md already commits to this
  discipline (decision 2026-09-16).
- Claude Code has the most polished interaction grammar: queued messages
  listed above the input with `Up` take-back, permission answers with
  attached comments, guided `/rewind` granularity. Its queueing UX is the
  model if the universal/ACP TUI ever grows its own composer (it currently
  must not — Cline owns the patched TUI's interaction).
- Where TUIs complement web: terminal owns the hot path; browser owns
  review/monitor/share. Workflow's split (browser operator UI + supervised
  Cline TUI) already matches the 2026 convergence pattern.

## 5. 2026 table-stakes matrix vs Workflow web UI

| Pattern | 2026 norm | Workflow web (2026-09-17 audit) |
|---|---|---|
| Streaming markdown + typed tool cards | everywhere | ✅ has (kind badge + status + IO) |
| Tool-kind icons | ACP spec suggests; Zed/Cursor render | ❌ text badge only |
| Diff coloring (+/−/hunk) | everywhere in coding UIs | ❌ monochrome `<pre>` (git rail + tool IO) |
| Model/effort/mode picker in composer | everywhere | ✅ has (configOptions) |
| Thinking collapsed, expandable | everywhere | ✅ has |
| Plan checklist w/ progress | Zed/Cursor/ACP | ✅ has (no priority display) |
| Permission card w/ once/always scope | ACP option kinds | ✅ has (tool-scoped only) |
| Queue-while-running | Cursor/Zed/Cline | ✅ has (no steer/send-now) |
| Token/cost/context near composer | Cursor ring; Zed footer | ⚠️ inspector only; composer meter unused |
| Session list: search, rename, relative time, active marker | everywhere | ⚠️ has search/rename; absolute timestamps; no active marker |
| Light/dark/system theme | consumer table stakes; Claude Mar 2026 | ❌ dark only |
| Humanist prose typography (mono for code) | every leader; Cline CLI itself moved to Inter+Geist Mono (4.1.9) | ❌ 100% monospace incl. prose |
| Collapsible rails / focus mode | ChatGPT/Claude sidebar collapse | ❌ none |
| Rich empty state w/ suggested prompts | ChatGPT/Claude/Gemini home | ❌ single dashed box sentence |
| Live activity while running (what + elapsed) | Codex "pauses when it needs you"; Cursor status | ⚠️ static "agent is working…" |
| Copy per message + per code block | universal | ✅ has |
| Export/share | OpenCode /share; Codex snapshots | ✅ markdown export (local) |

Audit facts (CDP, 2026-09-17): all measured text/background pairs pass WCAG
AA (min 5.09:1); no console errors/exceptions; responsive stack puts chat
first below 1100px; three-column grid at 1440px is 351/666/351 with the
thread capped at 74ch.

## 6. Improvement plan (web first)

Implemented in this branch (all presentation-layer; kernel/application
authority untouched; every mutation still crosses guarded Workflow
endpoints):

1. **Prose typography.** Assistant markdown, welcome copy, plan/completion/
   attention/thinking text move to a humanist sans stack; operator chrome
   (header, panels, badges, composer, tool titles, subjects, code) stays
   monospace. Code fences keep mono + highlight.js. Rationale: every 2026
   leader reserves mono for code; even Cline's own CLI moved to Inter + Geist
   Mono. Identity is preserved — the control-room chrome remains mono/amber.
2. **Light theme + System/Dark/Light control** (settings popover,
   `prefers-color-scheme` respected, persisted locally, applied pre-paint in
   `main.tsx` to avoid a flash). Light tokens keep the amber accent for fills
   and shift accent-*text* to a darker amber that passes AA on light surfaces.
3. **Tool-kind icons** on tool cards (ACP `kind` → SVG glyph).
4. **Diff rendering** — unified diffs render with add/del/hunk coloring in
   the git rail and tool I/O (pure client-side line classification).
5. **Live activity line** while a turn runs: current activity (last
   in-progress tool / thinking / writing) + elapsed seconds, replacing the
   static "agent is working…" text. `aria-live` preserved.
6. **Composer-adjacent usage chip** (tokens + cost) — the unused
   `usage-meter-composer` placement, now rendered; inspector meter unchanged.
7. **Focus mode** — header toggle collapses the git rail and inspector so the
   thread centers (persisted; ≥1100px only), matching sidebar-collapse norms.
8. **Empty state** — wordmark, honest one-line description (copy preserved),
   three suggested-prompt chips that fill the composer, shortcut hints.
9. **Sessions list** — relative timestamps ("just now", "5m ago"), full
   timestamp on hover, active-session marker.
10. **Heading semantics** — page title becomes `h1`.
11. **Settings dialog** (operator request 2026-09-17; supersedes the
    2026-09-15 "settings popover" scoping decision recorded above) — a modal
    from the composer gear or Ctrl/Cmd+, surfaces every operator preference in
    one place: color theme, focus mode, all agent-advertised options (model,
    effort, mode, tool toggles — synced with the composer pickers through the
    same state), ask-mode and process/network capabilities, remembered
    permission decisions, thinking-block display, completion notifications,
    the keyboard map, and the session's enforcement/usage facts. Composer
    pickers stay for speed; the dialog is the complete map.

Deferred (tracked, not built here — see `docs/web-ui-feature-tiers.md`):
per-turn model/effort stamps in the transcript (needs a channel-level config
snapshot at submit time), steering/send-now alongside queue, @-file mentions
and slash-command surfacing (`available_commands_update`), pattern-scoped
permission rules (OpenCode-style `git *` allow), per-hunk accept/reject,
checkpoints in the browser, share snapshots, search across transcripts.

## 7. TUI (second priority) — recommendation, not implemented

`DESIGN.md` and `PRODUCT.md` fix the runnable TUI as Cline 3.0.61's interface
under a bounded patch; visual/interaction redesign there is out of scope by
contract. Research-backed TUI guidance for the *universal/ACP* surface and
future work, when its own interaction model is on the table:

- Adopt Claude Code's queue affordance grammar (queued list above input,
  take-back, Esc flush) before any new composer feature.
- Keep the OSC-11/ANSI-slot theming discipline already decided 2026-09-16;
  OpenCode's `system` theme (bg-sampled grayscale, `"none"` inheritance) is
  the reference implementation.
- Diff style: width-adaptive `auto`/`stacked` (OpenCode) rather than
  side-by-side in narrow terminals; Crush is the only TUI with a documented
  split option.
- Cost/context meters in the status bar (Cline CLI already shows branch +
  tokens + cost — keep parity if the universal TUI grows its own status line).

## 8. Sources (fetched 2026-09-17)

help.openai.com/en/articles/6825453-chatgpt-release-notes ·
support.claude.com/en/articles/12138966-release-notes, /9487310, /8887527,
/8664678 · blog.google (I/O 2026 keynote; Gemini app posts; Windows app) ·
perplexity.ai/changelog + help-center "What is Computer?" · docs.x.ai
(release notes, Grok Bot overview) · microsoft.com Copilot blog (Oct 2025,
Nov 2025, Feb 2026, May 2026) · docs.librechat.ai (+ changelog, 2026
roadmap) · github.com/lobehub/lobehub (releases, RFCs, llms.txt) ·
docs.openwebui.com + github.com/open-webui/open-webui/releases ·
cursor.com/changelog + docs (agent, plan mode, run modes, security) ·
zed.dev/docs/ai/agent-panel + blogs (parallel agents, split diffs,
sandboxing, agent metrics) · cognition.ai/blog + devin.ai (Devin Desktop,
Devin Review, stacked PRs) · github.com/cline/cline README + CHANGELOG ·
github.com/iOfficeAI/AionUi · agentclientprotocol.com (v1 spec pages, v2
overview, clients list) + github.com/formulahendry/acp-ui ·
developers.openai.com/codex (features, permission modes, review) ·
opencode.ai/docs (tui, themes, keybinds, permissions) ·
github.com/charmbracelet/crush · aider.chat/docs · geminicli.com +
github.com/google-gemini/gemini-cli · code.claude.com/docs (interactive
mode, checkpointing, commands).

Flags: ChatGPT/Claude/Grok consumer UIs verified via help centers
(login-walled apps); LobeChat's current chat-compare UI and avatar styling
not re-verified in current docs; typography/radii/spacing specs are
unpublished by every vendor — visual claims above are limited to what
official sources state; Zed default-theme specifics unverified.

**Supersession note (2026-09-18, W050 step 6).** The vendored-Cline SDK runtime,
its `.workflow-cline/` checkout, and its Workflow patch were removed on branch
`feat/w050-cline-removal` (not yet merged), together with the hub's
Cline-specific `/before-tool` and `/team-task` routes. The thin stock-ACP
connector is retained (`src/integrations/cline-launch.ts` resolves ambient
`cline --acp`; the `cline` agent kind composes the generic ACP runtime) and is
probe-PENDING on stock 3.0.62. Prior statements in this record that treat the
patched Cline TUI as the runnable product surface are historical; the browser
operator UI over stock-ACP OpenCode is the default surface.

## Addendum — 2026-09-18 battlestation pass (branch `feat/web-ui-battlestation`)

Dated continuation of this research record; the sections above are kept as
history. Sources fetched this pass: openrouter.ai OpenAPI docs
(`/analytics/meta`, `/analytics/query`, `/credits` — fetched 2026-09-18) and
the OpenCode source checkout for the theme engine (github.com/sst/opencode,
MIT: `packages/ui/src/theme/{color,resolve,loader}.ts`, 37 desktop theme
JSONs vendored to `src/ui/webapp/themes/`).

- **Theme catalog (item 2 of §2 becomes concrete).** OpenCode's desktop
  web theme model is one JSON per theme with `light`/`dark` variants over a
  seed palette; the Workflow port restores the published OKLab matrices,
  maps seeds onto Workflow's existing 17 tokens, and adds an AA correction
  (`ensureAA`) so every catalog theme passes the operator contrast bar in
  both modes — mechanically gated in `test/webapp-palettes.test.ts`.
- **Parallel sessions replace the one-process invariant.** Multiple live
  ACP runtimes behind one browser surface, per-session turns and parked
  permission prompts, bounded by a live cap with LRU eviction; see the
  2026-09-18 supersession note in `docs/web-ui-feature-tiers.md`. This
  closes the "multiplexed driver" follow-up the earlier tiers doc deferred.
- **OpenRouter spend page (new).** OpenRouter exposes no public
  generations-list endpoint for plain API keys; analytics and credits
  require a Management key (docs/guides/overview/auth/management-api-keys).
  The Usage page therefore runs on `/analytics/query` + `/analytics/meta` +
  `/credits` with a server-held management key, composes the table
  server-side, and renders an honest setup state when the key is absent
  (the key never reaches the browser). The meta endpoint gates which
  metrics/dimensions are queried — nothing is fabricated.
- **Anti-slop audit.** The taste pass ran against 12 real Chromium states
  (dark/light/Dracula × 1440/945/768) and fixed what the captures showed:
  pathname-matched static routes (query strings no longer 404 the shell),
  a bounded multi-column palette grid, authored SVG card glyphs, composed
  empty/setup panels, and a neutral palette composer-focus tint.
