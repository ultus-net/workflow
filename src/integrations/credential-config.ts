import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { validateCredentialDefinition, type CredentialDefinition } from "./credentials.js";

export function defaultCredentialConfigPath(): string {
  return resolve(homedir(), ".workflow", "credentials.json");
}

export function loadCredentialDefinitions(path = defaultCredentialConfigPath()): CredentialDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("credential metadata unavailable", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new TypeError("invalid credential metadata");
  return parsed.map((value) => {
    if (!isCredentialDefinition(value)) throw new TypeError("invalid credential metadata");
    validateCredentialDefinition(value);
    return value;
  });
}

export function saveCredentialDefinitions(
  definitions: readonly CredentialDefinition[],
  path = defaultCredentialConfigPath(),
): void {
  for (const definition of definitions) validateCredentialDefinition(definition);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(definitions, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function isCredentialDefinition(value: unknown): value is CredentialDefinition {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return typeof input.id === "string" && typeof input.label === "string" &&
    (input.kind === "api-key" || input.kind === "token") &&
    Array.isArray(input.allowedConsumers) && input.allowedConsumers.every((item) => typeof item === "string") &&
    Array.isArray(input.allowedPurposes) && input.allowedPurposes.every((item) => typeof item === "string") &&
    (input.workspace === undefined || typeof input.workspace === "string");
}
