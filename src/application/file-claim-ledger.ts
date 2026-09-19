import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ReadFingerprint } from "./host.js";

export function fingerprintFile(path: string): ReadFingerprint {
  const stat = statSync(path);
  return {
    path,
    digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: stat.size,
    modifiedNs: stat.mtimeMs.toString(),
  };
}

/** Read fingerprints and exclusive session claims for Policy-1 parity. */
export class FileClaimLedger {
  readonly #reads = new Map<string, ReadFingerprint>();
  readonly #claims = new Map<string, string>();

  recordRead(fingerprint: ReadFingerprint): void {
    this.#reads.set(fingerprint.path, fingerprint);
  }

  claim(sessionId: string, paths: readonly string[]): boolean {
    if (paths.some((path) => {
      const owner = this.#claims.get(path);
      return owner !== undefined && owner !== sessionId;
    })) return false;
    for (const path of paths) this.#claims.set(path, sessionId);
    return true;
  }

  release(sessionId: string): void {
    for (const [path, owner] of this.#claims) if (owner === sessionId) this.#claims.delete(path);
  }

  matchesCurrent(path: string, fingerprint: ReadFingerprint): boolean {
    const current = fingerprintFile(path);
    return current.path === fingerprint.path && current.digest === fingerprint.digest &&
      current.size === fingerprint.size && current.modifiedNs === fingerprint.modifiedNs;
  }

  hasRead(path: string): boolean { return this.#reads.has(path); }
}