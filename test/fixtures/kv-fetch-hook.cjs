// W156 azure-kv lane fixture: a preload hook (NODE_OPTIONS=--require) that
// routes the fake vault's two hostnames to the in-test fake-vault server.
//
// Why a fetch hook: the azure-kv lane drives the COMPILED admin bin
// (dist/cli/admin.js) as a child process with WORKFLOW_SECRET_STORE=azure-kv,
// so the real KeyVaultSecretStore executes its full REST + IMDS-token path.
// The only thing faked is the transport: DNS cannot be redirected for a
// child process in CI, so this hook rewrites the URL before the request
// leaves the process. Everything above the transport — URL construction,
// Bearer headers, JSON bodies, status handling, token parsing — is the real
// production code.
//
// The hook is inert unless WORKFLOW_TEST_KV_FAKE_TARGET is set, and it only
// rewrites two hostnames: the lane's canonical vault host
// (kv-test.vault.azure.net) and the IMDS metadata endpoint
// (169.254.169.254). Every other request passes through untouched.
"use strict";

const target = process.env.WORKFLOW_TEST_KV_FAKE_TARGET;
if (target !== undefined && target !== "") {
  const realFetch = globalThis.fetch;
  const routedHosts = new Set(["kv-test.vault.azure.net", "169.254.169.254"]);
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (routedHosts.has(url.hostname)) {
      return realFetch(`${target}${url.pathname}${url.search}`, init);
    }
    return realFetch(input, init);
  };
}
