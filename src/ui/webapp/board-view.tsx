import { boardProjection, GITHUB_ISSUES_PAGE_SIZE } from "../../integrations/task-provider.js";
import type { BoardOutcome, ExternalTask, WorkProductCardState } from "../../integrations/task-provider.js";
import type { IssueDetailOutcome, ProviderReadRecord } from "../../integrations/issue-detail.js";
import { BOARD_POLL_MS, BOARD_LINK_LIVENESS_LABELS, boardLinkLiveness } from "./presenters.js";
import { withColumnDensity, withColumnPageSize, type IssueViewState } from "./issue-view-state.js";
import type { GitStatus, GitWorktree } from "./app.js";
import { useEffect, useState } from "react";

/**
 * The Board page (W161): the hub's external task board projected live. The
 * columns derive ONLY from the provider-owned `state` field via the shared
 * `boardProjection` (provider order preserved) — never a UI-side status
 * guess — and the hub's honest bookkeeping (skipped provider rows, excluded
 * pull requests, truncation) renders only when nonzero. The provider's own
 * timestamps render verbatim (date prefix, no relative-time synthesis);
 * `undefined` means the board has not answered yet and `null` means the hub
 * is unavailable or predates the /api/board route.
 *
 * W167: the `read` record is the hub's own recorded provider-read state —
 * the ONLY source the card's liveness pill derives from (via the shared
 * `boardLinkLiveness`). No record renders no pill and no dashed link: nothing
 * may claim a freshness the hub has no record of. NOT-fresh renders dashed.
 *
 * W163: the closed column converges on the provider-owned state_reason —
 * done (completed) and cancelled (not_planned/duplicate) render only when
 * their authority exists, the legacy closed column stands for tasks without
 * one (and always, byte-identically, when the board carries no state_reason
 * at all). Each column renders at most BOARD_COLUMN_RENDER_CAP cards and
 * states the truncation honestly ("showing N of M received", keyed on the
 * RECEIVED count). The read cache's TTL/hit bookkeeping renders beside the
 * other honesty spans. The per-column page-size/density preferences arrive
 * via `viewState` (the browser-local IssueViewState — never a board-payload
 * field) and update through `onViewState`.
 *
 * W162 slice 2: the `in_progress` column derives ONLY from the hub's
 * registry-sourced `inProgress` payload (open cards with an active linked
 * run, joined by the raw-id contract) — rendered verbatim, never recomputed;
 * no payload, no column (the honest subset rule). Precedence: while a run is
 * active the card is in_progress — a still-executing run is not yet awaiting
 * review, so in_progress outranks the work-product state; once the run
 * finishes the payload drops the key and the W165 model decides.
 */
export function BoardView({ board, reason, read, workProducts, inProgress, viewState, onViewState, projectWorkspaces, gitStatus, worktrees, onOpenDetail }: {
  readonly board: BoardOutcome | null | undefined;
  readonly reason?: string | undefined;
  readonly read?: ProviderReadRecord | null | undefined;
  readonly workProducts?: Readonly<Record<string, WorkProductCardState>> | undefined;
  readonly inProgress?: readonly string[] | undefined;
  readonly viewState?: IssueViewState | undefined;
  readonly onViewState?: ((next: IssueViewState) => void) | undefined;
  readonly projectWorkspaces?: readonly string[] | undefined;
  /**
   * W176: the ALREADY-polled /api/git + /api/worktrees state (AppShell's
   * `useGitStatus`/`useWorktrees` passed through) — the ONLY source the
   * Board header's workspace strip may render.
   */
  readonly gitStatus?: GitStatus | undefined;
  readonly worktrees?: readonly GitWorktree[] | undefined;
  /**
   * W176 phase 3 (#347): the shell's card-detail opener — a card's detail
   * affordance routes through it so the W167 issue-detail surface renders
   * in the shell's contextual panel (the right-side region the run detail
   * uses) instead of the card's inline subregion. The opener memory rides
   * the guarded sessionStorage record (run-detail-state.ts, second record
   * shape); the shell's close returns focus to the invoking card and the
   * view to the opener page.
   */
  readonly onOpenDetail?: ((cardKey: string) => void) | undefined;
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
  // W165: the in_review set is the cards whose REGISTRY-sourced link names a
  // provider-owned open pull request — the hub's payload is the only source;
  // without the payload the column does not exist at all (no authority, no
  // column — the amendment's honest subset rule).
  const inReviewKeys = new Set<string>();
  if (workProducts !== undefined) {
    for (const task of board.board.tasks) {
      const card = workProducts[task.key];
      if (card?.state === "linked" && card.product.state === "open") inReviewKeys.add(task.key);
    }
  }
  // W162 slice 2: the in_progress set is the hub's OWN payload (registry
  // facts: open cards with an active linked run) — rendered verbatim, never
  // recomputed. Precedence: while a run is active the card is in_progress
  // (a still-executing run is not yet awaiting review), outranking the
  // work-product state; once the run finishes the payload drops the key and
  // the work-product state decides.
  const inProgressKeys = new Set<string>(inProgress ?? []);
  const inProgressTasks = board.board.tasks.filter((task) => inProgressKeys.has(task.key));
  const open = columns.open.filter((task) => !inReviewKeys.has(task.key) && !inProgressKeys.has(task.key));
  const closed = columns.closed.filter((task) => !inReviewKeys.has(task.key) && !inProgressKeys.has(task.key));
  // W163: the split columns reclassify the same way — a completed/cancelled
  // issue with a linked open PR lands in in_review like any other card.
  const done = columns.done.filter((task) => !inReviewKeys.has(task.key) && !inProgressKeys.has(task.key));
  const cancelled = columns.cancelled.filter((task) => !inReviewKeys.has(task.key) && !inProgressKeys.has(task.key));
  const inReview = board.board.tasks.filter((task) => inReviewKeys.has(task.key) && !inProgressKeys.has(task.key));
  const cacheLabel = board.board.cache === undefined
    ? undefined
    : `provider read ${board.board.cache.hit ? "cached" : "fresh"} — cache TTL ${Math.round(board.board.cache.ttlMs / 1000)}s${
      board.board.cache.revalidated === true
        ? ", revalidated just now"
        : board.board.cache.ageMs === undefined ? "" : `, ${Math.round(board.board.cache.ageMs / 1000)}s old`
    }`;
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
        {cacheLabel !== undefined && <span className="board-meta">{cacheLabel}</span>}
        <span className="board-meta" title="the hub re-reads the provider on this cadence">polled every {BOARD_POLL_MS / 1000}s</span>
        <WorkspaceStrip gitStatus={gitStatus} worktrees={worktrees} />
      </header>
      <div className="board-columns">
        <BoardColumn title="open" tasks={open} workProducts={workProducts} read={read} viewState={viewState} onViewState={onViewState} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        {inProgress !== undefined && (
          <BoardColumn title="in_progress" tasks={inProgressTasks} workProducts={workProducts} read={read} viewState={viewState} onViewState={onViewState} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        )}
        {workProducts !== undefined && (
          <BoardColumn title="in_review" tasks={inReview} workProducts={workProducts} read={read} viewState={viewState} onViewState={onViewState} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        )}
        {done.length > 0 && (
          <BoardColumn title="done" tasks={done} workProducts={workProducts} read={read} viewState={viewState} onViewState={onViewState} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        )}
        {cancelled.length > 0 && (
          <BoardColumn title="cancelled" tasks={cancelled} workProducts={workProducts} read={read} viewState={viewState} onViewState={onViewState} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        )}
        {(columns.stateReasonAuthority ? closed.length > 0 : true) && (
          <BoardColumn title="closed" tasks={closed} workProducts={workProducts} read={read} viewState={viewState} onViewState={onViewState} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        )}
      </div>
    </section>
  );
}

/** W176: the Board header's workspace strip — the workspace-level branch and
 * worktree live state from the ALREADY-polled `/api/git` + `/api/worktrees`
 * (AppShell's `useGitStatus`/`useWorktrees`, passed through `BoardView`).
 * WORKSPACE-level live state — never presented as a per-run record: the
 * framing is the strip's own title/hint element, and no row is attached to
 * or derived from any run card. Each worktree row renders its recorded
 * branch (or the honest "—" when git reports none) plus its recorded flags
 * (current / detached HEAD / bare); the workspace's change count comes from
 * the git-status poll. A poll that answered nothing renders the degraded
 * naming — "git unavailable" when nothing arrived, the missing record's name
 * when only one did — never a fabricated workspace state. */
export const WORKSPACE_STRIP_FRAMING = "workspace-level live state — never presented as a per-run record";

export function WorkspaceStrip({ gitStatus, worktrees }: {
  readonly gitStatus?: GitStatus | undefined;
  readonly worktrees?: readonly GitWorktree[] | undefined;
}) {
  const bothAbsent = gitStatus === undefined && worktrees === undefined;
  return (
    <div className="workspace-strip" role="status">
      <span className="workspace-strip-frame" title={WORKSPACE_STRIP_FRAMING}>workspace-level live state</span>
      {bothAbsent && <span className="workspace-strip-degraded">workspace live state unavailable — git unavailable</span>}
      {gitStatus !== undefined && (
        <span className="workspace-strip-branch">
          {gitStatus.branch} — {gitStatus.changes.length} changed path{gitStatus.changes.length === 1 ? "" : "s"}
        </span>
      )}
      {!bothAbsent && gitStatus === undefined && <span className="workspace-strip-degraded">git status unavailable</span>}
      {worktrees !== undefined && (
        <ul className="workspace-worktrees">
          {worktrees.map((worktree) => {
            const status = [
              ...(worktree.current ? ["current"] : []),
              ...(worktree.detached ? ["detached HEAD"] : []),
              ...(worktree.bare ? ["bare"] : []),
            ].join(", ");
            return (
              <li key={worktree.path} className="workspace-worktree" title={worktree.path}>
                <span className="workspace-worktree-branch">{worktree.branch ?? "—"}</span>
                {status !== "" && <span className="workspace-worktree-status">{status}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {!bothAbsent && worktrees === undefined && <span className="workspace-strip-degraded">worktree list unavailable</span>}
    </div>
  );
}

/** W163: the per-column render cap (paperclip's 200-per-column bound): the
 * payload keeps every received task; the view renders at most this many per
 * column and states the truncation honestly — "showing N of M received",
 * keyed on the RECEIVED count, never the rendered count (the LESS-0061
 * lesson). */
export const BOARD_COLUMN_RENDER_CAP = 200;

const BOARD_COLUMN_PAGE_SIZES = [25, 50, 100] as const;

/** One board column: the header count derives from the RECEIVED array itself
 * (the projection population, before any render cap); the render caps at the
 * column's page-size preference or the default cap, and a capped column
 * states "showing N of M received"; an empty column renders its honest empty
 * note — never a fabricated card. W163: the density preference marks the
 * container (data-density plus the compact class), and the per-column prefs
 * controls render only when the page supplies a handler — the preferences
 * live UI-local, never in the board payload. */
function BoardColumn({ title, tasks, workProducts, read, viewState, onViewState, projectWorkspaces, onOpenDetail }: {
  readonly title: "open" | "in_progress" | "in_review" | "done" | "cancelled" | "closed";
  readonly tasks: readonly ExternalTask[];
  readonly workProducts?: Readonly<Record<string, WorkProductCardState>> | undefined;
  readonly read: ProviderReadRecord | null | undefined;
  readonly viewState?: IssueViewState | undefined;
  readonly onViewState?: ((next: IssueViewState) => void) | undefined;
  readonly projectWorkspaces?: readonly string[] | undefined;
  /** W176 phase 3 (#347): the shell's card-detail opener, threaded to the cards. */
  readonly onOpenDetail?: ((cardKey: string) => void) | undefined;
}) {
  const prefs = viewState?.[title];
  const cap = prefs?.pageSize ?? BOARD_COLUMN_RENDER_CAP;
  const rendered = tasks.length > cap ? tasks.slice(0, cap) : tasks;
  return (
    <div className={`board-column${prefs?.density === "compact" ? " board-column-compact" : ""}`} data-density={prefs?.density}>
      {/* One template-literal child: the column header must render as a
          contiguous text node (the pins slice the markup on it). */}
      <h3>{`${title} (${tasks.length})`}</h3>
      {onViewState !== undefined && (
        <div className="board-column-prefs">
          <select
            className="board-column-page-size"
            aria-label={`${title} page size`}
            value={prefs?.pageSize === undefined ? "" : String(prefs.pageSize)}
            onChange={(event) => onViewState(withColumnPageSize(viewState ?? {}, title, event.target.value === "" ? undefined : Number(event.target.value)))}
          >
            <option value="">cap ({BOARD_COLUMN_RENDER_CAP})</option>
            {BOARD_COLUMN_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
          <button
            type="button"
            className="board-column-density"
            aria-label={`${title} density`}
            onClick={() => onViewState(withColumnDensity(viewState ?? {}, title, prefs?.density === "compact" ? "cozy" : "compact"))}
          >
            {prefs?.density === "compact" ? "cozy" : "compact"}
          </button>
        </div>
      )}
      {rendered.length < tasks.length && (
        <p className="board-meta board-column-count">{`showing ${rendered.length} of ${tasks.length} received`}</p>
      )}
      <ul aria-label={`${title} issues`}>
        {tasks.length === 0 ? (
          <li><p className="muted sessions-empty-note">no {title} issues</p></li>
        ) : rendered.map((task) => (
          <BoardCard key={task.key} task={task} workProduct={workProducts?.[task.key]} read={read} projectWorkspaces={projectWorkspaces} onOpenDetail={onOpenDetail} />
        ))}
      </ul>
    </div>
  );
}

/** One board card: the provider record rendered verbatim, plus the W162
 * delegate affordance after the meta row. The delegate dispatch composes
 * hub-side — the browser sends only the issue number and its workspace
 * choice; refusals render verbatim (the rendered-deny rule). W167: the card
 * carries the liveness pill derived ONLY from the hub's recorded provider
 * read, and the provider link renders dashed whenever the read is not fresh
 * (the pill's tooltip carries the record's verbatim reason, never laundered
 * into the label). W165: the card renders its registry-sourced work-product
 * state verbatim. W176 phase 3 (#347): the card carries its key as
 * `data-board-card` — the shell's focus-return identity (closing the
 * contextual panel returns focus to the invoking card) — and its detail
 * affordance OPENS the shell's contextual panel (the W167 surface renders
 * there) instead of an inline subregion. */
function BoardCard({ task, workProduct, read, projectWorkspaces, onOpenDetail }: {
  readonly task: ExternalTask;
  readonly workProduct: WorkProductCardState | undefined;
  readonly read: ProviderReadRecord | null | undefined;
  readonly projectWorkspaces?: readonly string[] | undefined;
  readonly onOpenDetail?: ((cardKey: string) => void) | undefined;
}) {
  const liveness = boardLinkLiveness(read, Date.now());
  const notFresh = liveness !== undefined && liveness !== "fresh";
  return (
    <li className="board-card" data-board-card={task.key} tabIndex={-1}>
      <a href={task.url} target="_blank" rel="noreferrer noopener" className={notFresh ? "board-link-not-fresh" : undefined}>
        <code>{task.key}</code> {task.title}
      </a>
      {task.labels.length > 0 && (
        <div className="board-card-tags">
          {task.labels.map((label) => <span key={label} className="board-tag">{label}</span>)}
        </div>
      )}
      <div className="board-card-meta">
        {liveness !== undefined && (
          <span className={`board-liveness board-liveness-${liveness}`} title={read?.reason}>
            {BOARD_LINK_LIVENESS_LABELS[liveness]}
          </span>
        )}
        {task.assignee !== undefined && <span className="board-meta">@{task.assignee}</span>}
        <span className="board-meta">{task.updatedAt.slice(0, 10)}</span>
      </div>
      <WorkProductStateView workProduct={workProduct} />
      <BoardDelegateButton task={task} projectWorkspaces={projectWorkspaces} />
      <BoardIssueDetailButton task={task} onOpenDetail={onOpenDetail} />
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

/** The card's work-product state (W165): the registry-sourced link and the
 * provider-owned PR state rendered VERBATIM — unlinked is honest, an
 * unreadable read renders its reason, and the read's as-of liveness is
 * stated. No attribution is synthesized: only fields the hub payload
 * carries render, and a card with no payload fact renders nothing. */
function WorkProductStateView({ workProduct }: {
  readonly workProduct: WorkProductCardState | undefined;
}) {
  if (workProduct === undefined) return null;
  if (workProduct.state === "unlinked") {
    return <div className="board-work-product">work product: unlinked</div>;
  }
  if (workProduct.state === "unreadable") {
    return <div className="board-work-product">work product: {workProduct.reason}</div>;
  }
  const { product } = workProduct;
  return (
    <div className="board-work-product">
      work product: <code>{product.key}</code> {product.state}
      {product.draft === true ? " draft" : ""} as of {product.asOf}
    </div>
  );
}

/** The open card's delegate dispatch (W162): POSTs ONLY the issue number
 * (plus the optional workspace) to /api/board/delegate — the run composes
 * hub-side from the hub's own provider read, the browser never supplies
 * attribution. Form state is UI-local (the IssueViewState model: view
 * preference, never task state); the refusal renders verbatim. W162
 * deferral (c): on a scoped project with exactly one workspace binding the
 * field comes up preselected (still user-editable); the POST body shape is
 * unchanged. */
export function BoardDelegateButton({ task, projectWorkspaces }: {
  readonly task: ExternalTask;
  readonly projectWorkspaces?: readonly string[] | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  const [workspace, setWorkspace] = useState(delegateDefaultWorkspace(projectWorkspaces));
  const [result, setResult] = useState<BoardDelegationResult | undefined>(undefined);
  const [pending, setPending] = useState(false);
  if (task.state !== "open") return null;
  // W170: the capability boundary renders BEFORE the click — the delegate
  // lane is GitHub-only this slice, so an ADO-fed card offers no button that
  // could only ever end in the hub's unconfigured refusal naming the GitHub
  // vars; it names the boundary instead (the rendered-deny rule, moved
  // earlier).
  if (task.provider !== "github") {
    return (
      <div className="board-delegate-area">
        <p className="muted sessions-empty-note">delegation is GitHub-only in this slice</p>
      </div>
    );
  }
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
        <BoardDelegateForm
          workspace={workspace}
          result={result}
          pending={pending}
          onWorkspaceChange={setWorkspace}
          onStart={() => void submit()}
        />
      )}
    </div>
  );
}

/** The revealed delegate form region (W162 deferral c): extracted as a
 * presentational surface so the prefilled workspace value is SSR-pinnable —
 * the live form renders only after the click-to-reveal state flips, so the
 * value is invisible to renderToStaticMarkup through the button itself.
 * The markup is identical to the region it replaced. */
export function BoardDelegateForm({ workspace, result, pending, onWorkspaceChange, onStart }: {
  readonly workspace: string;
  readonly result: BoardDelegationResult | undefined;
  readonly pending: boolean;
  readonly onWorkspaceChange: (value: string) => void;
  readonly onStart: () => void;
}) {
  return (
    <div className="board-delegate-form">
      <input
        className="board-delegate-workspace"
        aria-label="workspace"
        placeholder="workspace (optional)"
        value={workspace}
        onChange={(event) => onWorkspaceChange(event.target.value)}
      />
      <button type="button" className="board-delegate-start" disabled={pending} onClick={onStart}>start run</button>
      {result !== undefined && <BoardDelegationResultView result={result} />}
    </div>
  );
}

/** W162 deferral (c): the delegate form workspace preselection derives
 * ONLY from the scoped project workspace bindings — the single binding is
 * the honest default; zero, several, or an absent list leaves the field
 * empty (never an invented choice). The Board page passes nothing until it
 * gains project scoping (registered deferral), so the default is inert on
 * the unscoped board. */
export function delegateDefaultWorkspace(projectWorkspaces?: readonly string[]): string {
  if (projectWorkspaces === undefined || projectWorkspaces.length !== 1) return "";
  return projectWorkspaces[0] ?? "";
}

// ── W167: the read-only issue detail surface (this region only) ──

/** What the card's detail subregion renders: either the hub's own
 * issue-detail outcome (relayed verbatim — the view never synthesizes
 * attribution) or a refusal the web relay answered with (the rendered-deny
 * rule, like the delegation result). */
export type IssueDetailAnswer =
  | { readonly kind: "detail"; readonly outcome: IssueDetailOutcome }
  | { readonly kind: "refusal"; readonly code: string; readonly detail: string };

/**
 * Renders the issue detail VERBATIM: the provider's own description (absent
 * stays absent) and its comment thread (author, body, created — nothing
 * synthesized: a skipped row is counted, never given a guessed author,
 * timestamp, or count). Failure states render honestly — the unconfigured
 * hub, the provider error's verbatim reason, and a withheld capability as an
 * alert with its code. Relative-time synthesis is deliberately absent (no
 * "just now"); the provider's own timestamp renders as supplied.
 */
export function BoardIssueDetailView({ answer }: { readonly answer: IssueDetailAnswer }) {
  if (answer.kind === "refusal") {
    return (
      <div className="board-issue-detail">
        <span className="board-delegate-result board-delegate-denied" role="alert">
          {answer.detail}
          <span className="muted"> [{answer.code}]</span>
        </span>
      </div>
    );
  }
  const outcome = answer.outcome;
  if (outcome.state === "unconfigured") {
    return (
      <div className="board-issue-detail">
        <p className="muted sessions-empty-note">no provider configured on the hub</p>
      </div>
    );
  }
  if (outcome.state === "error") {
    return (
      <div className="board-issue-detail">
        <p className="muted sessions-empty-note">the provider could not be read — {outcome.reason}</p>
      </div>
    );
  }
  const detail = outcome.detail;
  return (
    <div className="board-issue-detail">
      <p className="board-issue-description">{detail.description ?? "the provider supplied no description"}</p>
      {detail.comments.length > 0 && (
        <ul className="board-issue-thread" aria-label="comment thread">
          {detail.comments.map((comment, index) => (
            <li key={`${comment.author}-${index}`} className="board-comment">
              <span className="board-comment-meta"><code>@{comment.author}</code> <span className="muted">{comment.createdAt}</span></span>
              <p className="board-comment-body">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {detail.comments.length === 0 && detail.commentsSkipped === 0 && (
        <p className="muted sessions-empty-note">no comments</p>
      )}
      {detail.commentsSkipped > 0 && (
        <span className="board-meta">{detail.commentsSkipped} provider row{detail.commentsSkipped === 1 ? "" : "s"} skipped</span>
      )}
      {detail.commentsTruncated === true && (
        <span className="board-meta">the provider's first comment page was full — more may exist</span>
      )}
    </div>
  );
}

/** The open card's detail affordance (W167, re-homed W176 phase 3 #347): the
 * click now OPENS the shell's contextual panel — the W167 surface renders
 * there (BoardCardDetailPanel reads the same read-only /api/board/task
 * relay: the issue number in the query string, a read never a mutation) —
 * instead of the card's own inline subregion. Inert without the shell's
 * wiring: an opener with nowhere to open renders disabled, never a silent
 * click. */
export function BoardIssueDetailButton({ task, onOpenDetail }: {
  readonly task: ExternalTask;
  readonly onOpenDetail?: ((cardKey: string) => void) | undefined;
}) {
  const parsed = /^#(\d+)$/.exec(task.key);
  if (parsed === null || parsed[1] === undefined) return null;
  return (
    <div className="board-issue-detail-area">
      <button
        type="button"
        className="board-issue-detail"
        disabled={onOpenDetail === undefined}
        onClick={() => onOpenDetail?.(task.key)}
      >detail</button>
    </div>
  );
}

/** W176 phase 3 (#347): the card detail panel's relay read — the SAME
 * read-only GET the W167 affordance made, read once per opened key; every
 * failure shape normalizes into the IssueDetailAnswer the W167 surface
 * renders (a refusal renders verbatim — the rendered-deny rule). */
function useIssueDetailAnswer(cardKey: string | undefined): { readonly answer: IssueDetailAnswer | undefined } {
  const [answer, setAnswer] = useState<IssueDetailAnswer | undefined>(undefined);
  useEffect(() => {
    if (cardKey === undefined) return undefined;
    let live = true;
    setAnswer(undefined);
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/api/board/task?key=${encodeURIComponent(cardKey)}`);
        if (!response.ok) {
          const parsedError = await response.json().catch(() => undefined) as { error?: string } | undefined;
          if (live) setAnswer({ kind: "refusal", code: `HTTP ${response.status}`, detail: parsedError?.error ?? "the hub does not offer issue detail" });
          return;
        }
        const payload = await response.json() as { detail?: unknown };
        if (live) setAnswer(isIssueDetailOutcome(payload.detail)
          ? { kind: "detail", outcome: payload.detail }
          : { kind: "refusal", code: "unexpected", detail: "the hub's answer was not an issue detail" });
      } catch (error) {
        if (live) setAnswer({ kind: "refusal", code: "unreachable", detail: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { live = false; };
  }, [cardKey]);
  return { answer };
}

/** W176 phase 3 (#347): the board card detail panel — the shell's right-side
 * contextual region (the same region composition the W175 run detail panel
 * uses) for ONE board card. The W167 issue-detail surface renders inside
 * AS-IS (its internals are pinned by construction in
 * test/issue-detail.test.ts); the panel adds only the region chrome: the
 * card key + the recorded title in the header and the back affordance
 * naming the opener page (the sessionStorage origin memory). The `answer`
 * prop is the pins' injection seat; without it the panel reads the relay
 * itself, once per opened key. */
export function BoardCardDetailPanel({ cardKey, opener, onBack, answer: injectedAnswer }: {
  readonly cardKey: string;
  /** The page that opened the panel (the sessionStorage origin memory) —
   * the back affordance names it verbatim. */
  readonly opener: string;
  readonly onBack: () => void;
  /** Injected answer (the pins drive it); undefined → the panel reads the
   * /api/board/task relay itself. */
  readonly answer?: IssueDetailAnswer | undefined;
}) {
  const polled = useIssueDetailAnswer(injectedAnswer === undefined ? cardKey : undefined);
  const answer = injectedAnswer !== undefined ? injectedAnswer : polled.answer;
  const title = answer !== undefined && answer.kind === "detail" && answer.outcome.state === "ok" ? answer.outcome.detail.title : undefined;
  return (
    <section className="run-detail" aria-label={"board card detail: " + cardKey}>
      <header className="run-detail-header">
        <div className="run-detail-titleline">
          <code className="run-detail-id">{cardKey}</code>
          {title !== undefined && <span className="card-detail-title">{title}</span>}
        </div>
        <button
          type="button"
          className="run-detail-back"
          onClick={onBack}
          title={"close the detail (Esc); back to " + opener}
          aria-label={"close the board card detail; back to " + opener}
        >
          back to {opener}
        </button>
      </header>
      <div className="run-detail-body">
        {answer === undefined
          ? <p className="runs-absent" role="status">issue detail: loading…</p>
          : <BoardIssueDetailView answer={answer} />}
      </div>
    </section>
  );
}

/** The relay payload's shape guard: only an object carrying one of the
 * outcome's own states passes — anything else renders as the honest
 * "unexpected" refusal instead of being coerced into a detail. An ok state
 * must actually carry its detail object (W170): a state-shaped answer
 * without its payload is the unexpected refusal too, not a render-time
 * throw. Unconfigured/error states keep their own render paths. */
export function isIssueDetailOutcome(value: unknown): value is IssueDetailOutcome {
  if (typeof value !== "object" || value === null) return false;
  const state = (value as { state?: unknown }).state;
  if (state !== "ok" && state !== "unconfigured" && state !== "error") return false;
  if (state === "ok" && (typeof (value as { detail?: unknown }).detail !== "object" || (value as { detail: unknown }).detail === null)) return false;
  return true;
}
