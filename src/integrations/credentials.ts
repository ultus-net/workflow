export interface SecretStore {
  has(id: string): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
  put(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export type CredentialDefinition = {
  id: string;
  label: string;
  kind: "api-key" | "token";
  allowedConsumers: readonly string[];
  allowedPurposes: readonly string[];
  workspace?: string;
};

export type CredentialMetadata = CredentialDefinition & {
  configured: boolean;
};

export type CredentialRequest = {
  reference: string;
  consumer: string;
  purpose: string;
  workspace: string;
};

export interface CredentialBroker {
  list(): Promise<CredentialMetadata[]>;
  materialize(request: CredentialRequest): Promise<string>;
}

export interface CredentialControlPlane extends CredentialBroker {
  set(definition: CredentialDefinition, value: string): Promise<void>;
  revoke(id: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();

  async has(id: string): Promise<boolean> {
    return this.#secrets.has(id);
  }

  async get(id: string): Promise<string | undefined> {
    return this.#secrets.get(id);
  }

  async put(id: string, value: string): Promise<void> {
    this.#secrets.set(id, value);
  }

  async delete(id: string): Promise<void> {
    this.#secrets.delete(id);
  }
}

export function createCredentialBroker(
  store: SecretStore,
  definitions: readonly CredentialDefinition[],
): CredentialBroker {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));

  return {
    async list(): Promise<CredentialMetadata[]> {
      return Promise.all(
        definitions.map(async (definition) => ({
          ...definition,
          configured: await store.has(definition.id),
        })),
      );
    },

    async materialize(request: CredentialRequest): Promise<string> {
      const id = parseSecretReference(request.reference);
      const definition = id === undefined ? undefined : byId.get(id);
      if (
        definition === undefined ||
        !definition.allowedConsumers.includes(request.consumer) ||
        !definition.allowedPurposes.includes(request.purpose) ||
        (definition.workspace !== undefined && definition.workspace !== request.workspace)
      ) {
        throw unavailableCredential();
      }

      const secret = await store.get(definition.id);
      if (secret === undefined) {
        throw unavailableCredential();
      }
      return secret;
    },
  };
}

export function createCredentialControlPlane(
  store: SecretStore,
  initialDefinitions: readonly CredentialDefinition[] = [],
  onDefinitionsChanged?: (definitions: readonly CredentialDefinition[]) => void | Promise<void>,
): CredentialControlPlane {
  const definitions = new Map(initialDefinitions.map((definition) => [definition.id, definition]));
  const broker = (): CredentialBroker => createCredentialBroker(store, [...definitions.values()]);
  return {
    list: () => broker().list(),
    materialize: (request) => broker().materialize(request),
    async set(definition, value): Promise<void> {
      validateCredentialDefinition(definition);
      if (value.length === 0) throw new TypeError("credential value required");
      const previousDefinition = definitions.get(definition.id);
      const previousValue = await store.get(definition.id);
      await store.put(definition.id, value);
      definitions.set(definition.id, definition);
      try {
        await onDefinitionsChanged?.([...definitions.values()]);
      } catch (error) {
        if (previousDefinition === undefined) definitions.delete(definition.id);
        else definitions.set(definition.id, previousDefinition);
        const failure = error instanceof Error ? error : new Error(String(error));
        let outcome: SecretRollbackOutcome;
        try {
          outcome = await restoreSecret(store, definition.id, previousValue, failure);
        } catch (divergence) {
          // Metadata persistence failed and every compensating secret op
          // failed too: drop the in-memory definition so the live process
          // fails closed instead of serving the new value under the
          // rolled-back (older) authorization contract.
          definitions.delete(definition.id);
          throw divergence;
        }
        if (outcome !== "restored") {
          throw new Error(
            `credential '${definition.id}' set failed (${failure.message}); the previous secret could not be restored (${
              outcome.rollbackError
            }), so the credential is now unavailable (fail-closed) — re-set it`,
            { cause: error },
          );
        }
        throw failure;
      }
    },
    async revoke(id): Promise<void> {
      const definition = definitions.get(id);
      if (definition === undefined) throw unavailableCredential();
      const previousValue = await store.get(id);
      await store.delete(id);
      definitions.delete(id);
      try {
        await onDefinitionsChanged?.([...definitions.values()]);
      } catch (error) {
        definitions.set(id, definition);
        const failure = error instanceof Error ? error : new Error(String(error));
        if (previousValue !== undefined) {
          try {
            await store.put(id, previousValue);
          } catch (rollbackError) {
            // The metadata rolled back but the secret could not be
            // restored: the credential stays unmaterializable (fail-closed).
            // Surface both failures so the operator knows to re-set it.
            throw new Error(
              `credential '${id}' revoke rolled back (${failure.message}) but the previous secret could not be restored (${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }); the credential is now unavailable (fail-closed) — re-set it`,
              { cause: rollbackError },
            );
          }
        }
        throw failure;
      }
    },
  };
}

type SecretRollbackOutcome =
  | "restored"
  | { readonly kind: "fail-closed"; readonly rollbackError: string };

/**
 * Restores the secret store after a failed metadata change. When the
 * compensating restore op itself fails, the newly-set value must never stay
 * servable under the rolled-back (older) authorization contract: removing it
 * outright makes materialization fail closed (unavailable) instead. If even
 * that removal fails, the persisted metadata and the secret material have
 * diverged — report it loudly so the operator re-sets the credential.
 */
async function restoreSecret(
  store: SecretStore,
  id: string,
  previousValue: string | undefined,
  failure: Error,
): Promise<SecretRollbackOutcome> {
  try {
    if (previousValue === undefined) await store.delete(id);
    else await store.put(id, previousValue);
    return "restored";
  } catch (rollbackError) {
    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    if (previousValue !== undefined) {
      try {
        await store.delete(id);
        return { kind: "fail-closed", rollbackError: rollbackMessage };
      } catch {
        // Both compensating ops failed — report the divergence below.
      }
    }
    throw new Error(
      `credential '${id}' state diverged: metadata change failed (${failure.message}) and the secret rollback failed too (${rollbackMessage}); persisted metadata and secret material no longer agree — re-set the credential`,
      { cause: rollbackError },
    );
  }
}

export function validateCredentialDefinition(definition: CredentialDefinition): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(definition.id)) throw new TypeError("invalid credential id");
  if (definition.label.trim().length === 0) throw new TypeError("credential label required");
  if (definition.allowedConsumers.length === 0) throw new TypeError("credential consumer required");
  if (definition.allowedPurposes.length === 0) throw new TypeError("credential purpose required");
}

function parseSecretReference(reference: string): string | undefined {
  const match = /^secret:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(reference);
  return match?.[1];
}

function unavailableCredential(): Error {
  return new Error("credential unavailable");
}
