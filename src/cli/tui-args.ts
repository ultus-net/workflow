import { resolve } from "node:path";

export function resolveTuiWorkspace(args: readonly string[], fallback: string): string {
  const index = args.findIndex((arg) => arg === "--cwd" || arg === "-c");
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw new TypeError(`${args[index]} requires a path`);
  return resolve(fallback, value);
}

export function resolveTuiPetDir(args: readonly string[], fallback: string = process.cwd()): string | undefined {
  const index = args.indexOf("--pet");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) throw new TypeError("--pet requires a path");
  return resolve(fallback, value);
}
