import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { readCarePolicy, type CareRealityOrientation } from "./care-policy.js";

/**
 * W213 / Decision 2 (Option C: curated core + inert annotations): the care
 * fact store (`docs/decision-brief-seam-stores.md` lines 133-238).
 *
 * The store holds two channels that MUST NOT be conflated:
 *
 * - The curated CORE (`core.yaml`): human-edited, authoritative. The ONLY
 *   source of factual assertions. YAML because the operator edits it by hand,
 *   on the golden-source discipline the lessons registry and style packs use.
 * - The ANNOTATION channel (`annotations.json`): agent-written observations
 *   (Q29's self-reported claims get their home here). INERT: an annotation is
 *   never asserted unless the operator promotes it by deliberately editing it
 *   into the core. There is NO automatic promotion path — that is the point
 *   of choosing the hybrid over a pure structured store.
 *
 * The curated-core-only assertion rule (the brief's Q31 recommendation) is
 * enforced in CODE here, not convention: `assertion(key)` and `gate(keys)`
 * read the core ONLY. An annotation with the same key is never returned by
 * either. A claim is a keyed lookup against the small curated core — never a
 * per-claim LLM grounding call — and an ungrounded claim is dropped (fail
 * closed, no policy value needed; silence is the fallback).
 *
 * Placement: this module lives in the PLANE (`src/integrations/`), beside its
 * M7 peers `reminder-state-machine.ts` (W210) and `notify-delivery.ts`
 * (W208), because the hub is plane and the one-way arrow (plane never imports
 * `src/assistant/`, pinned by `test/assistant-isolation.test.ts`) forbids the
 * store from living assistant-side. The future care loop imports this module,
 * which the arrow permits.
 *
 * Discipline (mirrors `note-store.ts` / `reminder-state-machine.ts`):
 * bounded (document-order caps), injectable dir, honest absence (a MISSING
 * dir/file is the honest empty channel), never fabricate (a MALFORMED —
 * present-but-unparseable or schema-invalid — core or annotations file
 * THROWS; it never reads as empty, because a silently-empty core would hide
 * the very facts the rule exists to assert). The store loads a snapshot at
 * construction; re-read by constructing again (the hub projection helper does
 * exactly that per request, so an operator core edit is live on the next
 * read).
 */

const careFactSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  category: z.enum(["person", "medication", "schedule", "preference", "other"]),
  note: z.string().optional(),
});

const careCoreSchema = z.object({
  facts: z.array(careFactSchema).default([]),
});

const careAnnotationSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  observedAt: z.string(),
  source: z.string(),
  note: z.string().optional(),
});

const careAnnotationsSchema = z.object({
  annotations: z.array(careAnnotationSchema).default([]),
});

/** One curated, human-edited core fact. The ONLY thing that may be asserted. */
export type CareFact = z.infer<typeof careFactSchema>;

/**
 * One agent-written observation. INERT audit data: it never overrides a core
 * fact and is never returned by `assertion`/`gate`. Promotion into the core
 * is a deliberate human edit to `core.yaml`; there is no automatic path.
 */
export type CareAnnotation = z.infer<typeof careAnnotationSchema>;

export interface CareFactsOptions {
  /** The care directory holding `core.yaml` and `annotations.json`. */
  readonly dir: string;
  /** Cap on core facts, document order (first N retained). Default 500. */
  readonly maxFacts?: number;
  /** Cap on annotations, document order (first N retained). Default 500. */
  readonly maxAnnotations?: number;
}

const DEFAULT_MAX_ENTRIES = 500;

const CORE_FILENAME = "core.yaml";
const ANNOTATIONS_FILENAME = "annotations.json";

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export interface CareFactsStore {
  /** The care directory this store reads. */
  readonly dir: string;
  /** The curated core ONLY (never annotations). Bounded, document order. */
  facts(): readonly CareFact[];
  /** The inert annotation channel, for audit. NEVER a source of assertions. */
  annotations(): readonly CareAnnotation[];
  /**
   * A KEYED lookup against the curated core ONLY. An annotation with the
   * same key is NEVER returned. Duplicate core keys resolve first-wins, in
   * document order.
   */
  assertion(key: string): { readonly present: true; readonly value: string } | { readonly present: false };
  /**
   * The curated-core-only gate over a set of intended claim keys: keys
   * present in the core are grounded (input order preserved); absent keys
   * are dropped (fail closed — silence is the fallback). Duplicate keys
   * collapse (first occurrence decides position). The annotation channel is
   * never consulted.
   */
  gate(keys: readonly string[]): {
    readonly grounded: readonly { readonly key: string; readonly value: string }[];
    readonly dropped: readonly string[];
  };
}

function loadCore(dir: string, maxFacts: number): readonly CareFact[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, CORE_FILENAME), "utf8");
  } catch (error) {
    if (isEnoent(error)) return []; // honest absence: no core file is the empty core
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    // Honest error surface: a present-but-unparseable core must NEVER read
    // as empty — that would silently unground every fact the rule asserts.
    throw new TypeError("invalid care core (" + join(dir, CORE_FILENAME) + "): not parseable YAML (" + (error instanceof Error ? error.message : String(error)) + ")", { cause: error });
  }
  const result = careCoreSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new TypeError("invalid care core (" + join(dir, CORE_FILENAME) + "): " + result.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; "));
  }
  return result.data.facts.slice(0, maxFacts);
}

function loadAnnotations(dir: string, maxAnnotations: number): readonly CareAnnotation[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ANNOTATIONS_FILENAME), "utf8");
  } catch (error) {
    if (isEnoent(error)) return []; // honest absence: no annotations file is the empty channel
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TypeError("invalid care annotations (" + join(dir, ANNOTATIONS_FILENAME) + "): not parseable JSON (" + (error instanceof Error ? error.message : String(error)) + ")", { cause: error });
  }
  const result = careAnnotationsSchema.safeParse(parsed);
  if (!result.success) {
    throw new TypeError("invalid care annotations (" + join(dir, ANNOTATIONS_FILENAME) + "): " + result.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; "));
  }
  return result.data.annotations.slice(0, maxAnnotations);
}

/**
 * Load the care fact store for `dir` (a snapshot). A missing dir or missing
 * files are honest absences (the empty core / the empty channel). A
 * present-but-malformed core or annotations file throws — never an invented
 * fact, never a silently-empty channel.
 */
export function createCareFacts(options: CareFactsOptions): CareFactsStore {
  const maxFacts = options.maxFacts ?? DEFAULT_MAX_ENTRIES;
  const maxAnnotations = options.maxAnnotations ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxFacts) || maxFacts < 1) throw new TypeError("care facts: maxFacts must be a positive integer");
  if (!Number.isInteger(maxAnnotations) || maxAnnotations < 1) throw new TypeError("care facts: maxAnnotations must be a positive integer");
  const facts = loadCore(options.dir, maxFacts);
  const annotationsList = loadAnnotations(options.dir, maxAnnotations);
  // Core-only assertion index, first-wins on duplicate keys (document order).
  const byKey = new Map<string, string>();
  for (const fact of facts) {
    if (!byKey.has(fact.key)) byKey.set(fact.key, fact.value);
  }
  return {
    dir: options.dir,
    facts: () => facts,
    annotations: () => annotationsList,
    assertion: (key: string) => {
      const value = byKey.get(key);
      if (value === undefined) return { present: false };
      return { present: true, value };
    },
    gate: (keys: readonly string[]) => {
      const grounded: { readonly key: string; readonly value: string }[] = [];
      const dropped: string[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        if (seen.has(key)) continue; // duplicate keys collapse
        seen.add(key);
        const value = byKey.get(key);
        if (value === undefined) {
          dropped.push(key); // ungrounded: dropped, fail closed
        } else {
          grounded.push({ key, value });
        }
      }
      return { grounded, dropped };
    },
  };
}

/**
 * The curated-core-only assertion rule, stated once, versioned, and STATIC:
 * no interpolation of untrusted data. The hub `/care` projection carries it
 * verbatim so a reader never has to infer the rule from behavior.
 */
export const CARE_ASSERTION_RULE =
  "curated-core-only/v1: every factual care assertion is a keyed lookup " +
  "against the curated core (core.yaml); the annotation channel " +
  "(annotations.json) is inert audit data and never asserts; an ungrounded " +
  "claim is dropped (fail closed); an annotation becomes a fact only by a " +
  "deliberate human edit to the core; there is no automatic promotion path.";

/**
 * The hub `/care` projection: the two channels kept SEPARATE (the
 * core/annotation boundary visible in the payload), the Q28 seam value (see
 * `care-policy.ts` — "unset" when the operator has not set it, honestly), and
 * the static rule statement. `root` names the directory the projection read.
 */
export interface CareProjection {
  readonly root: string;
  readonly facts: readonly CareFact[];
  readonly annotations: readonly CareAnnotation[];
  readonly realityOrientation: CareRealityOrientation;
  readonly rule: string;
}

/**
 * Compose the `/care` projection fresh from disk (a core edit is live on the
 * next read). Shares ONE care-dir resolution between the fact store and the
 * policy seam, per the W213 wiring. Throws on a malformed core, annotations,
 * or policy file — the hub surfaces that as a genuine error, never a
 * fabricated projection.
 */
export function readCareProjection(dir: string): CareProjection {
  const store = createCareFacts({ dir });
  const policy = readCarePolicy(dir);
  return {
    root: dir,
    facts: store.facts(),
    annotations: store.annotations(),
    realityOrientation: policy.realityOrientation,
    rule: CARE_ASSERTION_RULE,
  };
}
