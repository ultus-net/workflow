<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W168 - The Azure DevOps provider behind the one ExternalTask record shape (Complete) (2026-09-28)

**Source:** GitHub issue #320 (closed 2026-09-28); spec `docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md:292` (W168 section); landed in PR #328 (merge 2026-09-28T00:54:43Z, commit `86ede2d0`, 2026-09-28).

**What landed:**

- `src/integrations/azure-devops-provider.ts` (299 lines): the ADO work-item adapter (`azureDevOpsProviderFromEnv`, `fetchAzureDevOpsBoardTasks`) mapping `System.Title`/`State`/`Tags`/`AssignedTo` onto the SAME provider-neutral `ExternalTask` record shape (a provider variant, never a fork).
- `AZURE_DEVOPS_STATE_COLUMNS` pins the per-template state -> one column enum mapping; the PAT rides the `Authorization` header only and never appears in any returned payload (pinned by value); a work-item URL must be an `https` html href; a malformed row is skipped, not mid-mapping-thrown; transport errors fail closed.
- `src/integrations/task-provider.ts` widens the shared union with the `azure_devops` variant; both lanes configured yields an explicit ambiguity error.

**Evidence:** `test/azure-devops-provider.test.ts` 10/10 (lane classification; missing/malformed env; the state->column table pinned per template; per-row shape guard; full bounded board fetch with the token absent from the payload). Fits the issue's "credential never rides any payload (pin by value)" acceptance.
