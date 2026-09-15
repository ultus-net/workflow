# Control-plane credentials and admin dashboard

## Goal

Replace plaintext environment-file credentials with Workflow-owned credential
references. Workflow brokers credential use at the hub boundary while secret
material is held by an OS credential service or an explicitly configured
external vault. Add a privileged admin surface for managing that control-plane
configuration without exposing secret values to the ordinary operator UI.

## Security model

- Persist references and metadata, never credential values, in Workflow state,
  MCP settings, task evidence, logs, transcripts, project memory, or browser
  responses.
- Agent-facing code can request use of a credential but cannot read arbitrary
  secrets. `SecretStore` is an internal custody boundary; `CredentialBroker`
  is the consumer-facing authorization/materialization boundary.
- Each credential has explicit allowed consumers and optional workspace scope.
  An MCP server receives only credentials declared for that server.
- Materialize plaintext at the last boundary that requires it. For stdio MCP
  servers that require environment variables, construct only that child's
  environment; never mutate or rely on Workflow's ambient `process.env`.
- Prefer short-lived provider tokens when an integration supports them. Static
  API keys remain supported for providers that require them.
- Missing, locked, unauthorized, or unavailable credentials fail closed. There
  is no automatic fallback to `.env` or plaintext MCP configuration.
- Admin authority and credential-use authority are separate. The ordinary
  operator/browser surface must not gain secret-management authority merely by
  being able to run an agent session.
- A malicious MCP server can read any credential deliberately materialized to
  that server. Consumer scoping limits blast radius; it cannot make a recipient
  unable to inspect its own process environment.
- Same-user compromise, root/administrator compromise, and compromise of the
  OS keyring after unlock remain outside Workflow's confidentiality boundary.

## Contracts

`SecretStore` owns secret bytes and exposes no list operation that returns
values. Its initial production backend will use Linux Secret Service. Tests use
an in-memory implementation; production must never silently choose an in-memory
or plaintext-file backend.

`CredentialBroker` owns metadata and policy. A caller supplies a consumer
identity, credential reference, purpose, and workspace. Successful resolution
returns secret material only to trusted integration code at the final spawn or
request boundary. Denials do not reveal whether another consumer could access
the credential.

Credential references use `secret://<id>` externally. IDs are opaque stable
identifiers rather than values, usernames, or provider tokens.

## Delivery slices

### Slice 1 - Contracts and fail-closed broker

- Define `SecretStore`, credential metadata/policy, and `CredentialBroker`.
- Add an in-memory store for tests only.
- Prove allow/deny behavior, workspace scoping, absent-secret failure, and
  metadata/value separation with unit tests.
- Extend the threat model with credential custody and recipient-compromise
  limits.

### Slice 2 - Linux Secret Service backend

- Add a Secret Service adapter using the platform credential service rather
  than home-grown encryption.
- Detect an unavailable/locked service and fail closed with an operator-safe
  error.
- Store only the opaque Workflow credential ID as the lookup key plus minimal
  non-secret attributes needed by the platform service.
- Add integration tests that are environment-gated; unit tests remain
  deterministic and do not require a desktop keyring.

### Slice 3 - MCP credential injection

- Extend Workflow-owned MCP server configuration with credential bindings of
  `secret://id` to a specific environment variable or supported auth field.
- Resolve bindings in the trusted hub/runtime immediately before spawn.
- Build a minimal child environment and prove sibling MCP servers, agent tools,
  settings JSON, logs, and snapshots cannot observe the value.
- Migrate one MCP integration as the end-to-end canary before generalizing.

### Slice 4 - Admin control-plane API and dashboard

- Create a separate admin route/surface for control-plane health, MCP servers,
  credentials, policies, and later schedules/runs.
- Credential list responses expose metadata only: id, label, kind, configured
  state, allowed consumers, scope, and timestamps. There is no reveal endpoint.
- Mutations support create/replace, policy update, and revoke/delete. Secret
  values are accepted only on create/replace and are never echoed.
- Require a distinct admin capability even on loopback. Keep browser CSRF /
  Fetch-Metadata mutation protections; do not treat loopback as authentication.
- Add audit events containing actor/action/credential ID/consumer but never
  secret values.

### Slice 5 - Provider sessions and external vaults

- Add OAuth/device-flow integrations where useful; keep refresh credentials in
  the store and materialize short-lived access tokens where possible.
- Add optional external backends (for example Azure Key Vault, 1Password, or
  Bitwarden) behind `SecretStore` without changing broker callers.
- Define rotation/expiry health and surface it in the admin dashboard.

## Acceptance criteria

- No production credential value is written to a Workflow-managed plaintext
  file or canonical persisted state.
- No general-purpose agent/MCP/browser API returns a stored secret.
- Unauthorized consumers and mismatched workspace scopes fail closed.
- A configured MCP can authenticate using a brokered credential while a sibling
  MCP cannot observe it.
- Credential replacement and revocation take effect without rewriting project
  `.env` files.
- The admin dashboard can manage credential metadata and replace/revoke values
  without ever displaying an existing value.
- Threat-model, API, unit/integration, and security-review evidence ship with
  each slice.
