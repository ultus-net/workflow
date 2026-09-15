import { describeFailure } from "./failure-copy.js";

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
              <pre>{data.rawOutput}</pre>
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
            <span className={entry.status === "completed" ? "part-plan-done-text" : undefined}>{entry.content}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Collapsible agent reasoning; default collapsed, streamed chunks accumulate. */
export function ThinkingPart({ data }: { readonly data: { readonly text: string } }) {
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
      <span>{data.text}</span>
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
      {data.text.length > 0 && <span>{data.text}</span>}
    </div>
  );
}
