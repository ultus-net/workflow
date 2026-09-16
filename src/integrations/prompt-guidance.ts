/**
 * Plan Task G5: advisory prompt guidance. The hub is the ACP client, so it
 * owns what it sends — guidance built here is PREPENDED to prompts by
 * composing surfaces. This replaces the plugin's tool.definition honesty
 * edits and system.transform steering, and it is HONESTLY ADVISORY: it is
 * prompt text, never a security boundary, and surfaces must not present it
 * as enforcement.
 */

export interface AdvisoryGuidanceParts {
  /** Terse style steering (e.g. the caveman speech style). */
  readonly styleNote?: string;
  /** Workflow operating rules the operator wants restated (short lines). */
  readonly workflowNotes?: readonly string[];
}

export function buildAdvisoryGuidance(parts: AdvisoryGuidanceParts): string | undefined {
  const blocks: string[] = [];
  if (parts.styleNote !== undefined && parts.styleNote.trim().length > 0) {
    blocks.push(`Response style (advisory): ${parts.styleNote.trim()}`);
  }
  if (parts.workflowNotes !== undefined && parts.workflowNotes.length > 0) {
    const notes = parts.workflowNotes.map((note) => `- ${note.trim()}`);
    if (notes.length > 0) blocks.push(`Operating notes (advisory — the Workflow hub enforces its rules independently of this text):\n${notes.join("\n")}`);
  }
  if (blocks.length === 0) return undefined;
  return `${blocks.join("\n\n")}\n\n`;
}

export interface AdvisoryGuidanceEnv {
  /** Terse style steering for hub-composed prompts. */
  readonly WORKFLOW_ADVISORY_STYLE?: string | undefined;
  /** Operating notes, one per line, for hub-composed prompts. */
  readonly WORKFLOW_ADVISORY_NOTES?: string | undefined;
}

/**
 * G5 wiring: surfaces that compose prompts on the operator's behalf (the
 * hub's scheduled-run turns) read advisory guidance from the environment so
 * the operator's steering text reaches every hub-composed prompt. Empty or
 * unset variables compose to no guidance at all — silence is honest.
 */
export function advisoryGuidanceFromEnv(env: AdvisoryGuidanceEnv): string | undefined {
  const styleNote = env.WORKFLOW_ADVISORY_STYLE?.trim();
  const workflowNotes = env.WORKFLOW_ADVISORY_NOTES
    ?.split("\n")
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
  return buildAdvisoryGuidance({
    ...(styleNote !== undefined && styleNote.length > 0 ? { styleNote } : {}),
    ...(workflowNotes !== undefined && workflowNotes.length > 0 ? { workflowNotes } : {}),
  });
}
