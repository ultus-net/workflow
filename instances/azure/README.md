# Azure deployment instance — seed template

**Status:** Draft seed (W147, 2026-09-26). Structure and contract only; the
pipeline here deploys nothing yet. This folder is copied into a fresh work
Azure DevOps repo and filled in there — it stays generic so any deployment
instance can start from it.

## What this seed is

The starting skeleton for a **deployment instance** per
`docs/superpowers/specs/2026-09-26-deployment-instance-split.md`: it consumes
pinned open-core artifacts and supplies everything environment-specific.

| It consumes (open core) | It provides (this instance) |
| --- | --- |
| `infra/` bicep modules at a pinned tag | Instance params (`.bicepparam`), org/subscription values |
| Product container image, pinned by digest | AzDO pipeline, service connections, environments with approvals/checks |
| Released, reviewed artifacts only | Secret custody config (Key Vault refs), posture decisions |

## Instance checklist (fill in the work repo)

- [ ] Service connection to the work subscription (name: `TODO_service_connection`)
- [ ] Registry for the pinned image (`TODO_registry`) and pull authorization
- [ ] Region, resource group, app name values in the params file
- [ ] Key Vault references for `OPENCODE_SERVER_PASSWORD` and provider keys
      (ACA-managed secrets are the C0 probe shortcut, not the end-state)
- [ ] Environment with approvals/checks matching the C-track posture
- [ ] Pin-verification wiring: the digest expectation is DOWNLOADED from the
      pinned tag's release (a git checkout does not carry release objects)
      and verify-pin.sh is invoked via bash with absolute paths
- [ ] Boards work item per instance PR, linked `AB#`, citing the open release tag consumed

## Rules (non-negotiable)

- No secrets in any committed file. Local-only connection material goes in a
  gitignored `instance.env` (the same discipline the C0 probe used for its
  `c0.env`).
- Nothing work-specific flows back into the open repo (the one-way rule).
- Image and module refs are pinned (digest/tag); moving refs are forbidden.

## Files

    instances/azure/
      README.md           this file — the contract and checklist
      azure-pipelines.yml draft two-checkout pipeline skeleton (TODO markers)
      verify-pin.sh       draft fail-closed digest-pin check (runs pre-deploy)
      params.bicepparam   draft parameter skeleton (TODO markers)
