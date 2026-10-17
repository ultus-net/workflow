import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main, type OpencodeServerDeps } from "../src/cli/opencode-server.js";
import type { WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import type { GuardCheckInput, GuardDecision } from "../src/integrations/guard-policy/index.js";

/**
 * W217 item 2 (issue #536): a DIRECT unit test of the daemon's reap-on-throw
 * contract. `src/cli/opencode-server.ts` composes the guard fail-closed
 * (`const guard = await createOpencodeServerGuard(workspace)`), then every
 * failure path AFTER composition must reap it explicitly (`await guard.close()`
 * before rethrow — the W094 contract, comments at `:266-287`). Until this pin,
 * only a generic source-regex (`test/opencode-server-launcher.test.ts`) asserted
 * the pattern; there was no test that DROVE the real fail-closed throw and
 * observed the reap.
 *
 * The real in-process guard's `close()` is a no-op, so the reap is unobservable
 * without a seam at the composition point — the alternative (spawning the whole
 * server) is environment-heavy. `main` therefore accepts an optional
 * `createGuard` injection (defaulted to the real vendor composition, so an
 * unparameterized caller is byte-identical). This test drives the exact
 * post-composition throw at `src/cli/opencode-server.ts:281-284` (the upstream
 * key resolution) and asserts the injected guard's `close()` ran, and that the
 * throw still propagates (fail closed, never swallowed).
 */

/** A guard double that records its reap; every other method is inert. */
function recordingGuard(): { readonly guard: WorkflowGuardProvider; readonly closes: () => number } {
  let closes = 0;
  const guard: WorkflowGuardProvider = {
    async capabilities() {
      return [{ name: "guard_check" }, { name: "guard_status" }];
    },
    async invoke() {
      return { decision: "allow", policy: "noop", reason: "test double" } satisfies GuardDecision;
    },
    async guardCheck(input: GuardCheckInput) {
      void input;
      return { decision: "allow", policy: "noop", reason: "test double" } satisfies GuardDecision;
    },
    async guardStatus() {
      return { mode: "test", enforcement: "test", executesActions: false };
    },
    async close() {
      closes += 1;
    },
  };
  return { guard, closes: () => closes };
}

/** Sets/removes env vars for the duration of `run`, restoring afterwards. */
async function withEnv(
  entries: Readonly<Record<string, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(entries)) {
    saved.set(key, process.env[key]);
    const value = entries[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("W217 (issue #536): a post-composition fail-closed throw reaps the composed guard", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-w217-reap-"));
  const { guard, closes } = recordingGuard();
  const deps: OpencodeServerDeps = { createGuard: () => Promise.resolve(guard) };

  // `WORKFLOW_UPSTREAM_KEY_FROM=azure-kv` names a secret store that cannot
  // supply the key without a vault name — the resolution throws AFTER the
  // guard is composed, so the daemon must reap the guard before rethrowing.
  let caught: unknown;
  await withEnv(
    {
      WORKFLOW_UPSTREAM_KEY_FROM: "azure-kv",
      WORKFLOW_KEYVAULT_NAME: undefined,
      WORKFLOW_KEYVAULT_URI: undefined,
    },
    async () => {
      try {
        await main(["--workspace", workspace], deps);
      } catch (error) {
        caught = error;
      }
    },
  );
  rmSync(workspace, { recursive: true, force: true });

  assert.ok(caught instanceof Error, "the fail-closed throw must propagate — a swallowed error would run guardless");
  assert.match((caught as Error).message, /azure-kv secret store/, "the propagated error is the real fail-closed cause");
  assert.equal(closes(), 1, "the composed guard must be reaped exactly once on the post-composition throw (W094)");
});
