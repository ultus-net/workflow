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

/** Turn completion marker; the text is omitted when it repeats the stream. */
export function CompletionPart({ data }: { readonly data: CompletionData }) {
  return (
    <div className={`part part-completion part-completion-${data.outcome}`}>
      <span className="part-label">{data.outcome}</span>
      {data.text.length > 0 && <span>{data.text}</span>}
    </div>
  );
}
