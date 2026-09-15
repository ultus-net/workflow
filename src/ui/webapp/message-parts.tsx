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
