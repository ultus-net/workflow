import { HttpRemoteEngine, type RemoteEngineEvent } from "../src/integrations/remote-acp/engine.js";

/**
 * Shared helpers for the gated remote-ACP probes. This module is imported by
 * probe tests; it is never run as a test on its own.
 */

export interface RemoteProbe {
  readonly engine: HttpRemoteEngine;
  readonly url: string;
  readonly cwd: string;
}

/** Resolves the remote server from the environment, or undefined when unset. */
export function remoteProbe(): RemoteProbe | undefined {
  const url = process.env.WORKFLOW_ACP_REMOTE_URL ?? process.env.OPENCODE_SERVER_URL;
  if (url === undefined || url === "") return undefined;
  const cwd = process.env.WORKFLOW_ACP_REMOTE_CWD ?? process.cwd();
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  return {
    url,
    cwd,
    engine: new HttpRemoteEngine({
      baseUrl: url,
      cwd,
      ...(username === undefined || username === "" ? {} : { username }),
      ...(password === undefined || password === "" ? {} : { password }),
    }),
  };
}

export interface EventCollector {
  readonly events: RemoteEngineEvent[];
  waitFor(predicate: (event: RemoteEngineEvent) => boolean, timeoutMs: number): Promise<RemoteEngineEvent | undefined>;
}

/** Subscribes to the engine SSE stream and exposes a polling waiter. */
export function collectEvents(engine: HttpRemoteEngine, cwd: string, signal: AbortSignal): EventCollector {
  const events: RemoteEngineEvent[] = [];
  void (async () => {
    try {
      for await (const event of engine.events({ cwd, signal })) events.push(event);
    } catch {
      // The probe asserts on collected evidence; a dropped stream ends collection.
    }
  })();
  return {
    events,
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = events.find(predicate);
        if (match !== undefined) return match;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return undefined;
    },
  };
}

/** True when any observed event is a permission request. */
export function hasPermissionRequest(events: readonly RemoteEngineEvent[]): boolean {
  return events.some((event) => event.type === "permission.asked");
}