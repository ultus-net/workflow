import type { CredentialBroker } from "./credentials.js";

export type McpCredentialBinding = {
  readonly variable: string;
  readonly reference: string;
};

export async function materializeMcpEnvironment(
  broker: CredentialBroker,
  options: {
    consumer: string;
    workspace: string;
    bindings: readonly McpCredentialBinding[];
  },
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const binding of options.bindings) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.variable)) {
      throw new TypeError("invalid MCP credential environment variable");
    }
    env[binding.variable] = await broker.materialize({
      reference: binding.reference,
      consumer: options.consumer,
      purpose: `stdio-env:${binding.variable}`,
      workspace: options.workspace,
    });
  }
  return env;
}
