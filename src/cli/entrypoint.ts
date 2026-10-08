import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether this module is the process entrypoint, robust to a symlinked bin.
 *
 * A package's `bin` entries are installed as SYMLINKS (npm/pnpm:
 * `/usr/local/bin/workflow-hub` -> `.../dist/cli/hub.js`). Node does not
 * resolve `argv[1]` through that symlink, so a lexical
 * `import.meta.url === pathToFileURL(argv[1])` compare — or a bare filename
 * regex against `argv[1]` — never matches a globally installed bin. The bin
 * then starts, no-ops, and exits 0: the daemon the container's CMD starts
 * silently does nothing (measured in-container 2026-10-09 on the control-plane
 * image; `workflow-opencode-server` exited 0 without opening the gateway).
 *
 * Resolution: realpath `argv[1]` before comparing it to `import.meta.url`.
 * The lexical compare is kept as a fallback for hosts that do not place a
 * real file at `argv[1]` (e.g. an ephemeral wrapper), and the raw compare
 * keeps source mode (`tsx src/cli/x.ts`) working when `import.meta.url` is
 * the `.ts` file itself.
 */
export function isEntrypoint(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  let resolved: string;
  try {
    resolved = realpathSync(argv1);
  } catch {
    resolved = argv1;
  }
  if (pathToFileURL(resolved).href === importMetaUrl) return true;
  return pathToFileURL(argv1).href === importMetaUrl;
}
