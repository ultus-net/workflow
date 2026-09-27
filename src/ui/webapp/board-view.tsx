import { boardProjection, GITHUB_ISSUES_PAGE_SIZE } from "../../integrations/task-provider.js";
import type { BoardOutcome, ExternalTask } from "../../integrations/task-provider.js";
import { BOARD_POLL_MS } from "./presenters.js";

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
        ) : tasks.map((task) => (
          <li key={task.key} className="board-card">
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
          </li>
        ))}
      </ul>
    </div>
  );
}
