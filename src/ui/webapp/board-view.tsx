import { boardProjection, GITHUB_ISSUES_PAGE_SIZE } from "../../integrations/task-provider.js";
import type { BoardOutcome, ExternalTask } from "../../integrations/task-provider.js";
import { BOARD_POLL_MS } from "./presenters.js";
import { useState } from "react";

/**
 * The Board page (W161): the hub's external task board projected live. The
 * two columns derive ONLY from the provider-owned `state` field via the
 * shared `boardProjection` (provider order preserved) — never a UI-side
 * status guess — and the hub's honest bookkeeping (skipped provider rows,
 * excluded pull requests, truncation) renders only when nonzero. The
 * provider's own timestamps render verbatim (date prefix, no relative-time
 * synthesis); `undefined` means the board has not answered yet and `null`
 * means the hub is unavailable or predates the /api/board route.
 */
export function BoardView({ board, reason }: {
  readonly board: BoardOutcome | null | undefined;
  readonly reason?: string | undefined;
}) {
  if (board === undefined) {
    return (
      <section className="sessions-view" aria-label="Task board">
        <p className="muted sessions-empty-note">the board has not answered yet</p>
      </section>
    );
  }
  if (board === null) {
    return (
      <section className="sessions-view" aria-label="Task board">
        <p className="muted sessions-empty-note">hub does not report a task board{reason !== undefined ? ` — ${reason}` : ""}</p>
      </section>
    );
  }
  if (board.state === "unconfigured") {
    return (
      <section className="sessions-view" aria-label="Task board">
        <p className="muted sessions-empty-note">no provider configured on the hub</p>
        <ul className="board-missing" aria-label="missing provider configuration">
          {board.missing.map((name) => (
            <li key={name}><code className="board-env-var">{name}</code></li>
          ))}
        </ul>
      </section>
    );
  }
  if (board.state === "error") {
    return (
      <section className="sessions-view" aria-label="Task board">
        <p className="muted sessions-empty-note">the provider could not be read — {board.reason}</p>
      </section>
    );
  }
  const columns = boardProjection(board.board);
  return (
    <section className="sessions-view" aria-label="Task board">
      <header className="sessions-view-head">
        <code>{board.board.repo}</code>
        {board.board.skipped > 0 && (
          <span className="board-meta">{board.board.skipped} provider row{board.board.skipped === 1 ? "" : "s"} skipped</span>
        )}
        {board.board.pullRequestsExcluded > 0 && (
          <span className="board-meta">{board.board.pullRequestsExcluded} pull request{board.board.pullRequestsExcluded === 1 ? "" : "s"} excluded</span>
        )}
        {board.board.truncated === true && (
          <span className="board-meta">showing the {GITHUB_ISSUES_PAGE_SIZE} most recently updated issues — more may exist</span>
        )}
        <span className="board-meta" title="the hub re-reads the provider on this cadence">polled every {BOARD_POLL_MS / 1000}s</span>
      </header>
      <div className="board-columns">
        <BoardColumn title="open" tasks={columns.open} />
        <BoardColumn title="closed" tasks={columns.closed} />
      </div>
    </section>
  );
}

/** One board column: header count derives from the projected array itself,
 * and an empty column renders its honest empty note — never a fabricated card. */
function BoardColumn({ title, tasks }: {
  readonly title: "open" | "closed";
  readonly tasks: readonly ExternalTask[];
}) {
  return (
    <div className="board-column">
      <h3>{title} ({tasks.length})</h3>
      <ul aria-label={`${title} issues`}>
        {tasks.length === 0 ? (
          <li><p className="muted sessions-empty-note">no {title} issues</p></li>
        ) : tasks.map((task) => <BoardCard key={task.key} task={task} />)}
      </ul>
    </div>
  );
}

/** One board card: the provider record rendered verbatim, plus the W162
 * delegate affordance after the meta row. The delegate dispatch composes
 * hub-side — the browser sends only the issue number and its workspace
 * choice; refusals render verbatim (the rendered-deny rule). */
function BoardCard({ task }: { readonly task: ExternalTask }) {
  return (
    <li className="board-card">
      <a href={task.url} target="_blank" rel="noreferrer noopener">
        <code>{task.key}</code> {task.title}
      </a>
      {task.labels.length > 0 && (
        <div className="board-card-tags">
          {task.labels.map((label) => <span key={label} className="board-tag">{label}</span>)}
        </div>
      )}
      <div className="board-card-meta">
        {task.assignee !== undefined && <span className="board-meta">@{task.assignee}</span>}
        <span className="board-meta">{task.updatedAt.slice(0, 10)}</span>
      </div>
      <BoardDelegateButton task={task} />
    </li>
  );
}

/** The rendered-delegation outcome (W162): a refusal renders its detail
 * and code VERBATIM as an alert (the TaskRefusal pattern — the UI never
 * polishes a denial into a success); a success names the run id. */
export interface BoardDelegationResult {
  readonly ok: boolean;
  readonly runId?: string;
  readonly code: string;
  readonly detail: string;
}

export function BoardDelegationResultView({ result }: { readonly result: BoardDelegationResult }) {
  return result.ok ? (
    <span className="board-delegate-result">{result.detail}</span>
  ) : (
    <span className="board-delegate-result board-delegate-denied" role="alert">
      {result.detail}
      <span className="muted"> [{result.code}]</span>
    </span>
  );
}

/** The open card's delegate dispatch (W162): POSTs ONLY the issue number
 * (plus the optional workspace) to /api/board/delegate — the run composes
 * hub-side from the hub's own provider read, the browser never supplies
 * attribution. Form state is UI-local (the IssueViewState model: view
 * preference, never task state); the refusal renders verbatim. */
export function BoardDelegateButton({ task }: { readonly task: ExternalTask }) {
  const [revealed, setRevealed] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [result, setResult] = useState<BoardDelegationResult | undefined>(undefined);
  const [pending, setPending] = useState(false);
  if (task.state !== "open") return null;
  const parsed = /^#(\d+)$/.exec(task.key);
  if (parsed === null || parsed[1] === undefined) return null;
  const issue = Number(parsed[1]);
  const submit = async (): Promise<void> => {
    setPending(true);
    try {
      const trimmed = workspace.trim();
      const response = await fetch("/api/board/delegate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issue, ...(trimmed.length > 0 ? { workspace: trimmed } : {}) }),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const parsedError = payload as { error?: string } | undefined;
        setResult({ ok: false, code: `HTTP ${response.status}`, detail: parsedError?.error ?? "the delegation was refused" });
        return;
      }
      const delegation = (payload as { delegation?: { state?: string; runId?: string; missing?: readonly string[]; reason?: string } } | undefined)?.delegation;
      if (delegation?.state === "ok") {
        setResult({
          ok: true,
          code: "200",
          detail: `delegated as run ${delegation.runId}`,
          ...(delegation.runId === undefined ? {} : { runId: delegation.runId }),
        });
      } else if (delegation?.state === "unconfigured") {
        setResult({ ok: false, code: "provider unconfigured", detail: (delegation.missing ?? []).join(", ") });
      } else if (delegation?.state === "error") {
        setResult({ ok: false, code: "provider error", detail: delegation.reason ?? "the provider could not be read" });
      } else {
        setResult({ ok: false, code: "unexpected", detail: "the hub's answer was not a delegation outcome" });
      }
    } catch (error) {
      setResult({ ok: false, code: "unreachable", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="board-delegate-area">
      <button type="button" className="board-delegate" disabled={pending} onClick={() => setRevealed(true)}>delegate</button>
      {revealed && (
        <div className="board-delegate-form">
          <input
            className="board-delegate-workspace"
            aria-label="workspace"
            placeholder="workspace (optional)"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          />
          <button type="button" className="board-delegate-start" disabled={pending} onClick={() => void submit()}>start run</button>
          {result !== undefined && <BoardDelegationResultView result={result} />}
        </div>
      )}
    </div>
  );
}
