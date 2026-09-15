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
        if (previousValue === undefined) await store.delete(definition.id);
        else await store.put(definition.id, previousValue);
        throw error;
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
        if (previousValue !== undefined) await store.put(id, previousValue);
        throw error;
      }
    },
  };
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
