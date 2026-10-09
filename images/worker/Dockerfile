# Worker job image (C1 deploy plan §2.d; spec §3:71-91). Shape A: ONE queue
# message = ONE execution = ONE bounded stock-opencode run in a disposable pod.
#
# Mirrors `images/control-plane/Dockerfile` structure + vendoring: same base,
# same lockfile install, same vendored sha-verified stock opencode, same pinned
# v2.0.10 release asset. Differences are deliberate and named:
#   - No gateway/hub/daemon code runs here; the ENTRY is the dependency-free
#     worker script `images/worker/run.mjs` (Node builtins only).
#   - No ingress, no ambient credentials, no baked tokens. Every secret is a
#     Key Vault ref NAME in the dispatch message and is materialized in memory
#     at run time (spec §3:83-84, plan §5 P1).
#   - `USER node` from the start (D6): no Files mount here, so no root reason.
#
# The toolbox ships so its EXECUTABLE corpus is present for the run-time
# fingerprint check (spec §11:293-298); the digest is written at build time
# (`--write-fingerprint`) and re-derived + compared in the pod before any work.
# A mismatch refuses the run, fail-closed.
#
# NOTE: no `rm -rf /var/lib/apt/lists/*` — the workflow guard rejects recursive
# deletions of system paths; apt-get clean only.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=v2.0.10

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && apt-get clean

WORKDIR /app

# Install from the lockfile with install scripts disabled (supply-chain
# default), then build the vendored toolbox (the corpus the worker verifies)
# and shed devDependencies — the exact plane-image recipe.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY mcp-toolbox ./mcp-toolbox
COPY assets ./assets
# pnpm version tracks mcp-toolbox/package.json's packageManager field; CI=true
# is pnpm's documented non-interactive signal (the plane-image findings — see
# images/control-plane/Dockerfile lines 47-57 for the measured failures).
RUN CI=true npm install -g pnpm@11.5.2 \
 && CI=true npm run build \
 && CI=true node scripts/prepare-tool.mjs \
 && npm prune --omit=dev

# Vendored, sha-verified opencode (the SAME asset + pin as the plane image).
COPY images/control-plane/opencode.sha256 /opt/opencode.sha256
COPY images/control-plane/opencode /usr/local/bin/opencode
RUN chmod 0755 /usr/local/bin/opencode \
 && cd /usr/local/bin \
 && sha256sum -c /opt/opencode.sha256 \
 && opencode --version | grep -q "${OPENCODE_VERSION}"

# The worker entry + its build-time corpus fingerprint. The digest is written
# AFTER the toolbox build so it reflects the exact corpus the image ships.
COPY images/worker/run.mjs /opt/workflow/run.mjs
RUN node /opt/workflow/run.mjs --write-fingerprint /opt/workflow/corpus-fingerprint

# D6: the unprivileged `node` user runs the worker; no process needs root.
# The state root is pre-created node-owned; the fingerprint file stays
# root-owned but world-readable (0644), which is all the worker needs.
RUN mkdir -p /home/node/.workflow && chown -R node:node /home/node
USER node

# Run the worker entry (Node builtins only); KEDA starts one execution per
# dequeued message.
CMD ["node", "/opt/workflow/run.mjs"]
