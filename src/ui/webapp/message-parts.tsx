import type { ReactNode } from "react";

import { describeFailure } from "./failure-copy.js";
import { DiffText, looksLikeDiff } from "./diff-text.js";
import { useSessionState } from "./runtime.js";

interface ActionData {
  readonly action: string;
  readonly subjects: readonly string[];
}

interface OutcomeData {
  readonly action: string;
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly detail?: string;
}

interface CompletionData {
  readonly outcome: "completed" | "failed";
  readonly text: string;
}

/** Tool call proposed through Workflow's authorization boundary. */
export function ActionPart({ data }: { readonly data: ActionData }) {
  return (
    <div className="part part-action">
      <span className="part-label">action</span>
      <code>{data.action}</code>
      {data.subjects.length > 0 && (
        <span className="part-subjects">{data.subjects.join("  ")}</span>
      )}
    </div>
  );
}

const TOOL_KIND_LABELS: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  fetch: "Fetch",
  think: "Think",
  other: "Tool",
};

const TOOL_STATUS_LABELS: Record<string, string> = {
  pending: "awaiting",
  in_progress: "running",
  completed: "done",
  error: "error",
  cancelled: "cancelled",
};

/** ACP suggests clients pick icons per tool kind; these are authored in one
 * consistent 1.4 stroke weight rather than unicode stand-ins. */
function toolIcon(kind: string): ReactNode {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const svg = (paths: ReactNode): ReactNode => (
    <svg viewBox="0 0 16 16" width="13" height="13" {...stroke} aria-hidden="true">{paths}</svg>
  );
  switch (kind) {
    case "read":
      return svg(<><path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3" /><path d="M5.5 8.5h5M5.5 10.5h3.5" /></>);
    case "edit":
      return svg(<><path d="M3 13l0.8-3.2L11.6 2 14 4.4 6.2 12.2 3 13z" /><path d="M10.3 3.3l1.9 1.9" /></>);
    case "delete":
      return svg(<><path d="M3 4.5h10" /><path d="M6 4.5V3h4v1.5" /><path d="M4.5 4.5l0.7 8.5h5.6l0.7-8.5" /><path d="M6.8 7v4M9.2 7v4" /></>);
    case "move":
      return svg(<><path d="M8 2.5v11" /><path d="M5.5 5L8 2.5 10.5 5" /><path d="M5.5 11L8 13.5 10.5 11" /><path d="M2.5 8h11" /></>);
    case "search":
      return svg(<><circle cx="7" cy="7" r="4" /><path d="M10.2 10.2L13.5 13.5" /></>);
    case "execute":
      return svg(<><path d="M2.5 4.5h11v7.5h-11z" /><path d="M5 10.5l2.4-2.3L5 6" /><path d="M8.7 10.5h2.3" /></>);
    case "fetch":
      return svg(<><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11" /><path d="M8 2.5c1.9 2 2.9 3.6 2.9 5.5s-1 3.5-2.9 5.5c-1.9-2-2.9-3.6-2.9-5.5s1-3.5 2.9-5.5z" /></>);
    case "think":
      return svg(<><path d="M8 2l1.2 3.3L12.5 6.5l-3.3 1.2L8 11l-1.2-3.3L3.5 6.5l3.3-1.2z" /><path d="M12 11l0.6 1.6L14.2 13l-1.6 0.4L12 15l-0.6-1.6L9.8 13l1.6-0.4z" /></>);
    default:
      return svg(<><path d="M3 8.5a2.3 2.3 0 012.3-2.3c0.4-1.3 1.6-2.2 3-2.2s2.6 0.9 3 2.2A2.3 2.3 0 0112.6 10H4.8A2 2 0 013 8.5z" /><path d="M6 12.5v1.2M8.5 12v2M11 12.5v1.2" /></>);
  }
}

interface ToolData {
  readonly kind: "tool";
  readonly callId: string;
  readonly title: string;
  readonly toolKind: string;
  readonly status: "pending" | "in_progress" | "completed" | "error" | "cancelled";
  readonly subjects: readonly string[];
  readonly rawInput?: string | undefined;
  readonly rawOutput?: string | undefined;
}

/** Typed tool-call card: kind, live status, subjects, and collapsible I/O. */
export function ToolPart({ data }: { readonly data: ToolData }) {
  const kindLabel = TOOL_KIND_LABELS[data.toolKind] ?? data.toolKind;
  return (
    <div className={`part part-tool part-tool-${data.status}`}>
      <div className="part-tool-head">
        <span className="part-tool-icon" aria-hidden="true">{toolIcon(data.toolKind)}</span>
        <span className="part-tool-kind" aria-hidden="true">{kindLabel}</span>
        <code className="part-tool-title">{data.title}</code>
        <span className={`part-tool-status part-tool-status-${data.status}`}>
          {TOOL_STATUS_LABELS[data.status] ?? data.status}
        </span>
      </div>
      {data.subjects.length > 0 && (
        <div className="part-subjects">{data.subjects.join("  ")}</div>
      )}
      {(data.rawInput !== undefined || data.rawOutput !== undefined) && (
        <details className="part-tool-io">
          <summary>input / output</summary>
          {data.rawInput !== undefined && (
            <div className="part-tool-io-block">
              <span className="part-tool-io-label">input</span>
              <pre>{data.rawInput}</pre>
            </div>
          )}
          {data.rawOutput !== undefined && (
            <div className="part-tool-io-block">
              <span className="part-tool-io-label">output</span>
              {looksLikeDiff(data.rawOutput)
                ? <DiffText text={data.rawOutput} />
                : <pre>{data.rawOutput}</pre>}
            </div>
          )}
        </details>
      )}
    </div>
  );
}

interface PlanEntryData {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/** Agent plan checklist; each update replaces the previous snapshot. */
export function PlanPart({ data }: { readonly data: { readonly entries: readonly PlanEntryData[] } }) {
  const done = data.entries.filter((entry) => entry.status === "completed").length;
  return (
    <div className="part part-plan">
      <div className="part-plan-head">
        <span className="part-label">plan</span>
        <span className="part-plan-progress">{done}/{data.entries.length}</span>
      </div>
      <ol className="part-plan-entries">
        {data.entries.map((entry) => (
          <li key={entry.id} className={`part-plan-entry part-plan-${entry.status}`}>
            <span className="part-plan-marker" aria-hidden="true">
              {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "◐" : "○"}
            </span>
            <span className={`part-prose${entry.status === "completed" ? " part-plan-done-text" : ""}`}>{entry.content}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Collapsible agent reasoning; default collapsed, streamed chunks accumulate.
 * Rendering the block at all is an operator preference (settings toggle): the
 * item stays in the transcript so toggling never shifts message ids.
 */
export function ThinkingPart({ data }: { readonly data: { readonly text: string } }) {
  const { showThinking } = useSessionState();
  if (!showThinking) return null;
  return (
    <details className="part part-thinking">
      <summary>Thinking</summary>
      <pre className="part-thinking-text">{data.text}</pre>
    </details>
  );
}

/** Result of an authorized tool call. */
export function OutcomePart({ data }: { readonly data: OutcomeData }) {
  return (
    <div className={`part part-outcome part-outcome-${data.outcome}`}>
      <span className="part-label">{data.outcome}</span>
      <code>{data.action}</code>
      {data.detail !== undefined && <span className="part-detail">{data.detail}</span>}
    </div>
  );
}

/** Tutor/diagnostic attention note. */
export function AttentionPart({ data }: { readonly data: { readonly text: string } }) {
  return (
    <div className="part part-attention">
      <span className="part-label">checkpoint</span>
      <span className="part-prose">{data.text}</span>
    </div>
  );
}

/** Turn completion marker; failures render as plain cause + next step, raw detail secondary. */
export function CompletionPart({ data }: { readonly data: CompletionData }) {
  if (data.outcome === "failed") {
    const failure = describeFailure(data.text);
    return (
      <div className="part part-completion part-completion-failed">
        <span className="part-label">failed</span>
        <span className="part-failure">
          {failure.summary}
          {failure.detail !== undefined && (
            <details className="part-failure-detail">
              <summary>technical detail</summary>
              <code>{failure.detail}</code>
            </details>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="part part-completion part-completion-completed">
      <span className="part-label">completed</span>
      {data.text.length > 0 && <span className="part-prose">{data.text}</span>}
    </div>
  );
}
