/**
 * Shared bubblewrap argument construction for the containment backends.
 *
 * Extracted from `linux-bwrap.ts` (W183) so the proxied backend composes the
 * exact same filesystem/credential boundary as the isolated/host backend and
 * differs only in the network posture. Keeping one builder means the hardlink
 * overlay order, executable binds, PATH assembly, and mount-mode semantics
 * cannot drift between postures.
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ContainedProcessRequest, WritableMountMode } from "./contracts.js";

export function requireAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
}

export function requireWritableMountMode(value: WritableMountMode | undefined): WritableMountMode {
  if (value === undefined) return "read-write";
  if (value !== "read-write" && value !== "read-write-no-delete") {
    throw new TypeError("writableMountMode must be read-write or read-write-no-delete");
  }
  return value;
}

/**
 * Every regular file under a granted writable tree (symlinks and special
 * files skipped). `read-write-no-delete` re-binds these files writable on top
 * of a read-only bind of the tree so in-place writes work while directory
 * entries stay read-only — bubblewrap cannot express "writable entries,
 * unlink denied", so creation is blocked as the price of enforcing no-delete.
 */
function writableRegularFiles(path: string): string[] {
  const files: string[] = [];
  const visit = (candidate: string): void => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files.push(candidate);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(candidate)) visit(resolve(candidate, entry));
  };
  visit(path);
  return files;
}

function isStrictlyNestedUnderAny(path: string, parents: readonly string[]): boolean {
  for (const parent of parents) {
    if (path === parent) continue;
    const rel = relative(parent, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

function externalHardlinks(path: string): string[] {
  const inodes = new Map<string, { nlink: number; paths: string[] }>();
  const visit = (candidate: string): void => {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (stat.nlink <= 1) return;
      const key = `${stat.dev}:${stat.ino}`;
      const seen = inodes.get(key);
      if (seen) seen.paths.push(candidate);
      else inodes.set(key, { nlink: stat.nlink, paths: [candidate] });
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(candidate)) visit(resolve(candidate, entry));
  };
  visit(path);
  const overlays = new Set<string>();
  for (const inode of inodes.values()) {
    if (inode.paths.length >= inode.nlink) continue;
    for (const alias of inode.paths) {
      const segments = relative(path, alias).split("/");
      // One overlay per affected top-level subtree keeps argv bounded for
      // package managers that hardlink thousands of files to an outer cache.
      overlays.add(segments.length > 1 ? resolve(path, segments[0]!) : alias);
    }
  }
  return [...overlays];
}

/** The mount/proc/dev/pid spine every posture shares. */
export function bubblewrapBaseArgs(cwd = "/"): string[] {
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
    "--chdir", cwd,
    "--clearenv",
    "--die-with-parent",
  ];
  if (existsSync("/etc")) args.unshift("--ro-bind", "/etc", "/etc");
  // systemd-resolved symlinks /etc/resolv.conf into /run, which is not
  // bound; without the resolved target the boundary breaks DNS (EAI_AGAIN)
  // for host-network processes.
  try {
    const resolvTarget = realpathSync("/etc/resolv.conf");
    if (resolvTarget !== "/etc/resolv.conf" && existsSync(resolvTarget)) {
      args.unshift("--ro-bind", resolvTarget, resolvTarget);
    }
  } catch {
    // No resolv.conf symlink target to repair
  }
  if (!process.execPath.startsWith("/usr/")) {
    const nodePrefix = resolve(dirname(process.execPath), "..");
    if (existsSync(nodePrefix)) args.unshift("--ro-bind", nodePrefix, nodePrefix);
  }
  try {
    const realHome = realpathSync(homedir());
    const userLocalBin = resolve(realHome, ".local", "bin");
    if (existsSync(userLocalBin)) args.unshift("--ro-bind", userLocalBin, userLocalBin);
    const npmDir = resolve(realHome, ".npm");
    if (existsSync(npmDir)) args.unshift("--ro-bind", npmDir, npmDir);
  } catch {
    // Unresolvable home directory
  }
  return args;
}

export interface BuiltBwrapInvocation {
  /** Mount/namespace/setenv args, NOT including the trailing command. */
  readonly mountArgs: string[];
  /** The command (executable + args) to run after `--`. */
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** Whether the caller must add `--unshare-net` (private netns). */
  readonly unshareNet: boolean;
}

/**
 * Builds the mount/environment spine and validates path shape. The caller
 * supplies the `network` string only to decide `unshareNet`; `mediated` is
 * rejected here so no builder can silently build a posture no backend runs.
 */
export function buildBubblewrapInvocation(
  request: ContainedProcessRequest,
  network: "isolated" | "host" | "proxied",
): BuiltBwrapInvocation {
  requireAbsolutePath(request.executable, "executable");
  if (request.cwd !== undefined) requireAbsolutePath(request.cwd, "cwd");
  for (const path of request.readablePaths ?? []) requireAbsolutePath(path, "readable path");
  for (const path of request.writablePaths ?? []) requireAbsolutePath(path, "writable path");
  const writableMountMode = requireWritableMountMode(request.writableMountMode);

  const environment = request.environment ?? {};
  const args = bubblewrapBaseArgs(request.cwd);
  // bwrap execs the child inside the new mount tree, so the executable must
  // exist there even when it lives outside the system binds (e.g. a
  // vendored agent binary under the repository). Bind the file
  // itself; symlinked launchers are resolved to their realpath on the host
  // and mounted at both paths so exec by either name works. A missing
  // binary is intentionally not probed: the bind targets the requested
  // path and bwrap's own execvp failure is the fail-closed error surface.
  const executableTarget = existsSync(request.executable) ? realpathSync(request.executable) : request.executable;
  args.push("--ro-bind", executableTarget, request.executable);
  if (executableTarget !== request.executable) args.push("--ro-bind", executableTarget, executableTarget);
  const hostBinPaths: string[] = [];
  if (!process.execPath.startsWith("/usr/")) hostBinPaths.push(dirname(process.execPath));
  try {
    const realHome = realpathSync(homedir());
    const userLocalBin = resolve(realHome, ".local", "bin");
    if (existsSync(userLocalBin)) hostBinPaths.push(userLocalBin);
  } catch {
    // Unresolvable home directory
  }
  const defaultPath = [...hostBinPaths, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  args.push("--setenv", "PATH", environment.PATH ?? defaultPath);
  for (const [name, value] of Object.entries(environment)) {
    if (name !== "PATH") args.push("--setenv", name, value);
  }
  for (const path of request.readablePaths ?? []) args.push("--ro-bind", path, path);
  const hardlinkOverlays = new Set<string>();
  for (const path of request.writablePaths ?? []) {
    if (writableMountMode === "read-write-no-delete") {
      args.push("--ro-bind", path, path);
      for (const file of writableRegularFiles(path)) args.push("--bind", file, file);
    } else {
      args.push("--bind", path, path);
    }
    for (const alias of externalHardlinks(path)) hardlinkOverlays.add(alias);
  }
  // A read-only grant nested under a writable one is shadowed by the later
  // writable bind (bwrap applies mounts in order, so the writable parent
  // overmounts the read-only child). Re-assert every strictly-nested
  // read-only grant AFTER the writable binds so the narrower read-only
  // boundary wins. Same-path readable+writable grants are intentionally left
  // to the writable bind (the caller asked for it writable).
  for (const readable of request.readablePaths ?? []) {
    if (isStrictlyNestedUnderAny(readable, request.writablePaths ?? [])) {
      args.push("--ro-bind", readable, readable);
    }
  }
  // Apply protections last so an overlapping writable grant cannot remount
  // an externally linked inode writable after its read-only overlay.
  for (const alias of hardlinkOverlays) args.push("--ro-bind", alias, alias);
  return {
    mountArgs: args,
    command: [request.executable, ...request.args],
    environment,
    unshareNet: network !== "host",
  };
}
