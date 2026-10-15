/**
 * W195 — the Routes page: the hub's assistant route summary projected live
 * (slice 1 of the hub overhaul; read-only). One column per route
 * (`coding | tutor | care`), each carrying the route name, the identities
 * bound to it (the identity → route bindings), and the capability set
 * withheld from it.
 *
 * The view surfaces operator CONFIG and fabricates nothing: the route rows,
 * the bound identities, and the withheld set all come from the hub's
 * `POST /assistant/routes` read (which composes them from the loaded route
 * config). A route with an empty withheld set renders the honest "nothing
 * withheld" state — never a synthesized capability. The full state cycle is
 * rendered: loading (`routes === undefined`, no reason), error (`reason`),
 * empty (a hub reporting no routes), and populated.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

/** One route row as the hub's /assistant/routes read returns it. */
export interface RouteRow {
  readonly route: "coding" | "tutor" | "care";
  readonly systemPrompt: string;
  readonly identities: readonly string[];
  /** Empty for coding/tutor; the care route's configured set otherwise. */
  readonly withheld: readonly string[];
}

export function RoutesView({ routes, reason }: {
  readonly routes: readonly RouteRow[] | undefined;
  readonly reason?: string | undefined;
}) {
  if (routes === undefined && reason === undefined) {
    return (
      <section className="sessions-view routes-view" aria-label="Routes">
        <header className="sessions-view-head">
          <h2>Routes</h2>
        </header>
        <p className="muted sessions-empty-note routes-loading">loading routes…</p>
      </section>
    );
  }
  if (routes === undefined) {
    return (
      <section className="sessions-view routes-view" aria-label="Routes">
        <header className="sessions-view-head">
          <h2>Routes</h2>
        </header>
        <p className="muted sessions-empty-note routes-error" role="status">
          routes unavailable ({reason})
        </p>
      </section>
    );
  }
  return (
    <section className="sessions-view routes-view" aria-label="Routes">
      <header className="sessions-view-head">
        <h2>Routes</h2>
        <p className="muted sessions-empty-note">
          the assistant's three routes, their bound identities, and each route's withheld capability set — read from config, never invented
        </p>
      </header>
      <div className="sessions-grid routes-grid">
        {routes.map((entry) => (
          <article key={entry.route} className="session-card routes-card">
            <header className="session-card-head">
              <span className="routes-route-name" title={entry.systemPrompt}>{entry.route}</span>
            </header>
            <footer className="session-card-meta routes-identities" title="identities bound to this route">
              <span className="session-card-title routes-field-label">identities</span>
              {entry.identities.length === 0 ? (
                <span className="muted routes-none">none bound</span>
              ) : (
                entry.identities.map((identity) => (
                  <span key={identity} className="session-agent-badge" title={identity}>{identity}</span>
                ))
              )}
            </footer>
            <footer className="session-card-meta routes-withheld" title="capabilities withheld from this route">
              <span className="session-card-title routes-field-label">withheld</span>
              {entry.withheld.length === 0 ? (
                <span className="muted routes-none">nothing withheld</span>
              ) : (
                entry.withheld.map((capability) => (
                  <span key={capability} className="session-focus-tag routes-withheld-tag">{capability}</span>
                ))
              )}
            </footer>
          </article>
        ))}
        {routes.length === 0 && (
          <p className="muted sessions-empty-note">no routes configured — set WORKFLOW_ASSISTANT_ROUTES to bind identities to routes</p>
        )}
      </div>
    </section>
  );
}
