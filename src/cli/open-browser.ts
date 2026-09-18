import { spawn } from "node:child_process";

export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Platform opener for a URL; `undefined` when no known opener applies. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand | undefined {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `start` is a cmd builtin; the empty argument is the required window title.
      return { command: "cmd", args: ["/c", "start", "", url] };
    case "linux":
      return { command: "xdg-open", args: [url] };
    default:
      return undefined;
  }
}

export interface OpenBrowserOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/**
 * Best-effort open of `url` in the operator's default browser. Fail-soft and
 * fail-honest: headless, contained, or CI environments without an opener
 * resolve `false` and the caller keeps serving. `WORKFLOW_NO_BROWSER=1`
 * suppresses it. Resolves `true` only once the opener process has actually
 * spawned; a missing binary (async `error`) resolves `false`.
 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.WORKFLOW_NO_BROWSER === "1") return Promise.resolve(false);
  const command = browserCommand(url, options.platform);
  if (command === undefined) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.command, [...command.args], { stdio: "ignore", detached: true });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
