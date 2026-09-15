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