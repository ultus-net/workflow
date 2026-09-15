#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { createCredentialControlPlane } from "../integrations/credentials.js";
import { defaultCredentialConfigPath, loadCredentialDefinitions, saveCredentialDefinitions } from "../integrations/credential-config.js";
import { createSecretServiceStore } from "../integrations/secret-service.js";
import { createAdminControlPlaneServer } from "../ui/admin-control-plane.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.WORKFLOW_ADMIN_PORT ?? "4180", 10);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("invalid WORKFLOW_ADMIN_PORT");

const adminToken = process.env.WORKFLOW_ADMIN_TOKEN ?? randomBytes(32).toString("base64url");
const credentialConfigPath = defaultCredentialConfigPath();
const credentials = createCredentialControlPlane(
  createSecretServiceStore(),
  loadCredentialDefinitions(credentialConfigPath),
  (definitions) => saveCredentialDefinitions(definitions, credentialConfigPath),
);
const server = createAdminControlPlaneServer({
  credentials,
  adminToken,
  audit: (event) => console.log(JSON.stringify({ type: "credential-audit", ...event })),
});
server.listen(port, host, () => {
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  console.log(`Workflow admin listening at http://${host}:${actualPort}`);
  console.log(`Admin capability: ${adminToken}`);
});

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
