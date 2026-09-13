import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ContainedProcessRequest, ContainedProcessResult, ProcessContainment } from "./contracts.js";

function requireAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
}

export class LinuxBubblewrapContainment implements ProcessContainment {
  constructor(readonly bwrapPath = "/usr/bin/bwrap") {}

  async execute(request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    requireAbsolutePath(request.executable, "executable");
    if (request.cwd !== undefined) requireAbsolutePath(request.cwd, "cwd");
    for (const path of request.readablePaths ?? []) requireAbsolutePath(path, "readable path");
    for (const path of request.writablePaths ?? []) requireAbsolutePath(path, "writable path");

    const network = request.network ?? "isolated";
    if (network !== "isolated" && network !== "host") throw new TypeError("network must be isolated or host");
    const environment = request.environment ?? {};
    const args = this.#baseArgs(request.cwd);
    if (network === "isolated") args.push("--unshare-net");
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
    for (const path of request.writablePaths ?? []) args.push("--bind", path, path);
    args.push("--", request.executable, ...request.args);

    await this.#probe(network);
    return await this.#spawn(args, network, Object.keys(environment).length === 0 ? "cleared" : "explicit");
  }

  async #probe(network: "isolated" | "host"): Promise<void> {
    const args = this.#baseArgs();
    if (network === "isolated") args.push("--unshare-net");
    args.push("--", "/usr/bin/true");
    const result = await this.#spawn(args, network, "cleared");
    if (result.exitCode !== 0) throw new Error("containment backend failed runtime probe");
  }

  #baseArgs(cwd = "/"): string[] {
    const args = [
      "--ro-bind", "/usr", "/usr",
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc",
      "--dev", "/dev",
      "--chdir", cwd,
      "--clearenv",
      "--die-with-parent",
    ];
    if (existsSync("/etc")) args.unshift("--ro-bind", "/etc", "/etc");
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

  async #spawn(
    args: readonly string[],
    network: "isolated" | "host",
    credentials: "cleared" | "explicit",
  ): Promise<ContainedProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.bwrapPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") reject(new Error("containment backend unavailable", { cause: error }));
        else reject(error);
      });
      child.on("close", (exitCode) => {
        if (stderr.startsWith("bwrap:")) {
          reject(new Error(`containment boundary could not be established: ${stderr.trim()}`));
          return;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          enforcement: "enforced",
          network,
          credentials,
        });
      });
    });
  }
}
