<!-- Ledger fragment: extracted from TASKS.md at line 1541 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W080 - Skill-embedded connector scoping (gated on the skill-delivery decision)

**Objective:** Let the generated `workflow-toolbox` skill (W077) declare which connectors it needs,
mounted on demand for the session and torn down after — the context-budget fix oh-my-openagent
ships as "skill-embedded MCPs". Hard constraint: skill-scoped mounts still cross the hub-written
config and guard authorization — scoping, never a bypass lane.

**Depends on:** the dated skill-delivery decision (W077 — native host skill injection stays off
until it exists).

**Acceptance criteria:**
- [x] The skill schema gains an optional `connectors` declaration validated against the toolbox
      catalog (unknown connector → fail loud). (**Done 2026-09-20, schema half only — the mount
      half stays gated on the skill-delivery decision, as the dependency states:**
      `validateSkillConnectors` in `src/integrations/toolbox-catalog.ts` — absent means no
      connector claims; an unknown name, a non-string entry, or a duplicate fails loud
      (`TypeError`), validated against the catalog that is the single source of truth;
      `toolboxSkillBody` renders a validated declaration into the frontmatter (`connectors:` list,
      frontmatter `version` bumped to 2) and stays byte-identical to the W077 corpus pin without
      one. Pins: `test/skill-connectors.test.ts` (4). **Mount half landed 2026-09-21** behind the
      operator's file-provisioning decision (see the delivery box below) — the note that a mount
      seam would be dead code applied to the pre-decision state only.)
- [x] Delivery (when it ships) mounts only declared connectors, through the existing launch-config
      path; the guard still owns authorization. (**Shipped 2026-09-21** behind the operator's
      file-provisioning decision (dated addendum in
      `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`): `provisionToolboxSkill`
      provisions the generated skill into the hub-owned `SKILLS_MCP_DIR` store (write-on-create/
      drift, idempotent; the store stays outside agent workspaces and the hub-written config now
      composes `"skill": "deny"` for the native skill tool — composed-but-probe-gated, honoring
      unverified live), and `skillConnectorMounts` composes the declared floor
      (`workflow-guard-mcp` + `skills-mcp`, built-filtered) into the hub-written config's mcp map —
      never duplicating the delivery mount or operator-enabled servers, and an explicit operator
      disable always wins over the declaration. Wired into BOTH lanes (ACP subprocess composition
      and the topology server config; best-effort delivery with visible degradation). Pins:
      `test/skill-delivery.test.ts` (4, incl. the skills.ts scan contract and stale-repair).)
- [x] Probe-gated per host version before any claim. (**Discipline held:** the store provisioning
      and scan contract are verified model-free (`test/skill-delivery.test.ts` exercises the
      `skills.ts` `scanSkills` contract against the provisioned store), while the in-agent
      `read_skill` delivery verdict on OpenCode stays probe-gated —
      `WORKFLOW_ACP_OPENCODE_SKILLS` remains `pending` in `docs/PROBE_VERDICTS.json` and no
      delivered-in-agent claim is made until it runs.)
