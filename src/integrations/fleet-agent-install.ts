import { OPENCODE_V2_METERED_PROVIDER_ID } from "./opencode-agent-config.js";
import type { FleetEntry } from "./fleet-payload.js";

/**
 * Install-time normalization for the vendored fleet's OpenCode agents.
 *
 * The vendored assets under `assets/opencode-fleet/agents/*.md` are the
 * operator-dotfiles golden tree and stay BYTE-IDENTICAL in this repository
 * (the manifest pins their sha256). Two of their frontmatter constructs do not
 * survive the control plane's runtime lane:
 *
 *  1. `model: synthetic/syn:<tier>:text` — the plane registers no `synthetic`
 *     provider (`OPENCODE_V2_METERED_PROVIDER_ID = "openrouter"` rides the
 *     metered loopback proxy), so the pin is inert and the agent falls back to
 *     the session default. The transform re-points the pin at the metered
 *     provider id, which is the id the plane's composed config actually
 *     registers; the proxy forwards the bare `syn:<tier>:text` model id to
 *     Synthetic on the primary hop.
 *  2. `action: external_directory` permission rules — the frontmatter grants
 *     access to paths outside the agent workspace (e.g.
 *     `~/.config/opencode/style/**`). The plane confines every session to the
 *     workspace, so such a rule can never authorize (a mapped request is denied
 *     as `WORKSPACE_PATH_DENIED`), and the adapter's older fail-closed
 *     `invalid ACP tool subject` on an unmappable ask only produced deny churn.
 *     The rules are dropped, and the style/standards docs the rules targeted are
 *     delivered instead by folding them into the installed global `AGENTS.md`
 *     (see {@link foldFleetAmbientDocs}) — the one ambient-injection path the
 *     pinned OpenCode v2.0.10 actually honors.
 *
 * The transform is a pure string operation over the frontmatter block only;
 * the document body and every other frontmatter line are preserved verbatim.
 * It is applied ONLY at the hub-owned runtime install (`installFleet`'s
 * `transform` seam), never to the CLI-lane install and never to the vendored
 * sources.
 */

/** The host-provider namespace the vendored agents pin; rewritten to the metered id. */
const VENDORED_PROVIDER = "synthetic/";

/** Rewrites a `model:` value's provider prefix from `synthetic/` to the metered provider id. */
export function rewriteFleetModelRef(ref: string): string {
  return ref.startsWith(VENDORED_PROVIDER)
    ? `${OPENCODE_V2_METERED_PROVIDER_ID}/${ref.slice(VENDORED_PROVIDER.length)}`
    : ref;
}

/** True when a permission-list line names the unmappable `external_directory` action. */
function isExternalDirectoryAction(line: string): boolean {
  return /(^|\s)action:\s*external_directory\s*$/.test(line);
}

/**
 * Normalizes one fleet agent payload (frontmatter-only). Returns the payload
 * unchanged when it has no recognizable frontmatter block, so a non-agent or a
 * future file shape is never corrupted by a partial rewrite.
 */
export function normalizeFleetAgentPayload(payload: Buffer): Buffer {
  const lines = payload.toString("utf8").split("\n");
  if (lines[0]?.trim() !== "---") return payload;
  let fence = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      fence = i;
      break;
    }
  }
  if (fence === -1) return payload;

  const out: string[] = [lines[0]!];
  let i = 1;
  while (i < fence) {
    const line = lines[i]!;
    const model = /^(model:\s*)(\S.*?)(\s*)$/.exec(line);
    if (model !== null) {
      out.push(`${model[1]}${rewriteFleetModelRef(model[2]!)}${model[3]!}`);
      i += 1;
      continue;
    }
    // A `permissions:` block is a YAML sequence of maps; drop any item whose
    // map names the unmappable `external_directory` action.
    if (/^permissions:\s*$/.test(line)) {
      out.push(line);
      i += 1;
      while (i < fence) {
        const head = /^(\s*)-\s/.exec(lines[i]!);
        if (head === null || head[1]!.length === 0) break;
        const baseIndent = head[1]!.length;
        const item: string[] = [lines[i]!];
        i += 1;
        while (i < fence) {
          const next = lines[i]!;
          if (next.trim() === "") break;
          const indent = /^(\s*)/.exec(next)![1]!.length;
          if (indent < baseIndent) break;
          if (indent === baseIndent && /^\s*-\s/.test(next)) break;
          if (indent === baseIndent) break;
          item.push(next);
          i += 1;
        }
        if (!item.some(isExternalDirectoryAction)) out.push(...item);
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  for (let j = fence; j < lines.length; j += 1) out.push(lines[j]!);
  return Buffer.from(out.join("\n"), "utf8");
}

/**
 * The `installFleet` transform seam: agents are normalized, every other kind
 * passes through byte-identical. Keeping the kind check here (rather than in
 * `installFleet`) means the transform is a single tested unit. The global
 * `AGENTS.md` ambient-doc fold is a separate step in `runtimeFleetTransform`
 * (it needs the sibling docs' bytes, which this per-entry seam does not see).
 */
export function normalizeFleetEntry(entry: FleetEntry, payload: Buffer): Buffer {
  return entry.kind === "agent" ? normalizeFleetAgentPayload(payload) : payload;
}

/**
 * D4 (plane-compat round 3): the workspace-boundary instruction the runtime
 * install folds into the installed global `AGENTS.md`, alongside the vendored
 * `STANDARDS.md` and style floor. The plane confines every session to its
 * workspace and denies any path outside it; before this, that denial ended the
 * whole turn (the v2 reject cascade turned a policy deny into a message-less
 * `DeclinedError` → `Effect.interrupt`), so the agent never learned the rule
 * and could not adapt. This guidance states the boundary up front — the "make
 * it easier for the agent not to break it" channel — while the composed
 * `permission.external_directory = "deny"` ruleset enforces it engine-natively
 * (a non-fatal `BlockedError` the tool reports, never a turn-killing decline).
 *
 * It is code-owned (never a vendored file), so the sha256-pinned vendored
 * assets stay byte-identical; the fold is a pure function of shipped bytes.
 */
export const WORKSPACE_BOUNDARY_GUIDANCE = `# Workspace boundary

Your workspace is the session working directory. Treat it as the whole world.

- Read and edit only paths inside the workspace. Use workspace-relative paths.
- Workflow denies any path outside the workspace (\`external_directory\`).
- Never read or edit Workflow's own source tree or its hub configuration. Those
  live outside the workspace, so Workflow denies them.
- When a tool reports a denied path, do not retry it. Continue with the files
  the workspace provides.
`;

/** A fixed, content-addressed banner that separates each folded ambient doc. */
function foldBanner(sourceLabel: string): string {
  return `# --- fleet:${sourceLabel} (folded into AGENTS.md at install) ---`;
}

/**
 * D3 — folds the fleet ambient context docs (`STANDARDS.md`, `style/
 * coding-style.md`) into the installed global `AGENTS.md`, the ONE
 * ambient-injection path OpenCode v2 honors.
 *
 * Measured 2026-10-13 against the pinned v2.0.10 binary (and corroborated by
 * the v2 docs): the config `instructions` array is ACCEPTED but NOT resolved —
 * v2 injects only discovered `AGENTS.md`, never the array's files/globs/URLs.
 * So composing absolute paths into `instructions` (the previous approach) left
 * `STANDARDS.md` and `coding-style.md` unreachable to agents on the plane.
 * Folding them into the discovered global `AGENTS.md` restores intended
 * delivery without editing the byte-pinned vendored sources.
 *
 * Pure and deterministic: a fixed function of the shipped (sha256-pinned)
 * sources, so the installed `AGENTS.md` hashes stably and `installFleet`'s
 * already-current short-circuit keeps working. `agentsMd` is the installed
 * global instructions doc; `ambientDocs` carries the fold in a fixed order
 * (STANDARDS before the style floor). When `ambientDocs` is empty the source is
 * returned byte-identical.
 */
export function foldFleetAmbientDocs(
  agentsMd: Buffer,
  ambientDocs: readonly { readonly label: string; readonly payload: Buffer }[],
): Buffer {
  if (ambientDocs.length === 0) return agentsMd;
  const base = agentsMd.toString("utf8");
  const trailingNewline = base.endsWith("\n");
  const parts: string[] = [trailingNewline ? base : `${base}\n`];
  for (const doc of ambientDocs) {
    const body = doc.payload.toString("utf8").replace(/\n+$/, "");
    parts.push(`${foldBanner(doc.label)}\n${body}\n\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}
