import { useEffect, useState } from "react";

import type { InvariantRow } from "../../kernel/invariants.js";

// W107 (amux C2): "all-clear must say what it judged." Every row renders its
// judged population beside its verdict, and an empty population renders the
// amux distinction — could-not-discriminate — never a silent pass. The rows
// arrive server-evaluated (kernel-side); this component only renders what
// the hub says and derives nothing from client-observed state.

const VERDICT_LABEL: Record<InvariantRow["verdict"], string> = {
  passed: "passed",
  failed: "failed",
  "could-not-discriminate": "could not discriminate",
};

export function InvariantsPanel(props: { readonly rows?: readonly InvariantRow[] }) {
  const [fetched, setFetched] = useState<readonly InvariantRow[] | undefined>(undefined);
  const rows = props.rows ?? fetched;
  useEffect(() => {
    if (props.rows !== undefined) return; // rows override (tests)
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/invariants");
        if (!response.ok) return;
        const loaded = await response.json() as { invariants: readonly InvariantRow[] };
        setFetched(loaded.invariants);
      } catch {
        // Honest absence: the panel stays hidden rather than showing a
        // fabricated all-clear.
      }
    };
    void load();
    return () => { /* single load per mount */ };
  }, [props.rows]);
  if (rows === undefined || rows.length === 0) return null;
  return (
    <details className="panel-disclosure" data-testid="invariants-panel">
      <summary>
        <span>Invariants</span>
        <span className="panel-summary-meta">{rows.length}</span>
      </summary>
      <section className="panel-disclosure-body" aria-label="Kernel invariants">
        <table className="usage-table invariants-table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`invariant-row invariant-${row.verdict}`}>
                <th scope="row">{row.label}</th>
                <td>
                  <span className={`invariant-verdict invariant-verdict-${row.verdict}`}>{VERDICT_LABEL[row.verdict]}</span>
                  {row.verdict === "could-not-discriminate" ? (
                    <span className="muted"> — judged nothing, so it says nothing about the fleet</span>
                  ) : (
                    <span className="muted"> — judged {row.judged}</span>
                  )}
                  {row.failures !== undefined && row.failures.length > 0 && (
                    <span className="invariant-failures"> ({row.failures.join(", ")})</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </details>
  );
}
