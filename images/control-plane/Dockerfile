# Control-plane image (W149, 2026-09-26; first LOCAL build + fixes 2026-10-09):
# packages the Workflow toolchain and a VENDORED stock opencode. Honest status:
# the image BUILDS (verified with podman, 2026-10-09) and the C1 in-container
# composition is now composed — the CMD at the bottom of this file is the
# `workflow-plane` supervisor (hub + OpenCode server daemon + gateway, with the
# pod as the containment boundary). See the dated supersession note there and
# docs/ledger/control-plane-c1-deploy-plan.md (task 3) +
# docs/ledger/control-plane-c1-composition.md.
# It carries no work-specific values — the instance seeds from it (spec §5).
#
# Vendoring discipline (mirrors infra/c0/image/Dockerfile): the qualified
# stock opencode build is NOT publicly fetchable (v2.0.10 is a dev-channel
# build; latest npm/GitHub release is v1.18.32). The operator attaches the
# binary to the tagged GitHub release as an asset; the publish workflow
# downloads it into this build context and sha-verifies it against
# opencode.sha256 BEFORE the build; the build fails on version drift.
#
# NOTE: no `rm -rf /var/lib/apt/lists/*` — the workflow guard rejects
# recursive deletions of system paths; apt-get clean only.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=v2.0.10

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && apt-get clean

WORKDIR /app

# Install from the lockfile with install scripts DISABLED (supply-chain
# default; the postinstall prepare-tool hook is heavyweight + network-bound —
# W137 finding (a) — and runs explicitly below, after the tree is complete).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Build the product, build the vendored toolbox, then shed devDependencies.
# Explicit destinations: a multi-source COPY whose destination is a directory
# copies each SOURCE's CONTENTS when the source itself is a directory (Docker
# semantics), which flattened `src/` to `/app/*.ts` and failed the build with
# TS18003 "No inputs were found" — measured in the first local build
# (2026-10-09). The config files and `src` get distinct explicit destinations.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY mcp-toolbox ./mcp-toolbox
COPY assets ./assets
# pnpm version must track mcp-toolbox/package.json's packageManager field:
# corepack's default shim resolves a newer pnpm and pnpm refuses the
# mismatch (ERR_PNPM_BAD_PM_VERSION — hit live in the first CI run,
# 2026-09-26). Update together with the toolbox pin.
#
# CI=true: `prepare-tool.mjs` runs `pnpm --dir mcp-toolbox run build`, which
# first reconciles the workspace's node_modules. With no TTY pnpm aborts that
# purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` → the toolbox build is
# skipped and the guard server never lands) — measured in the second local
# build (2026-10-09). CI=true is exactly the signal pnpm documents for a
# non-interactive install.
RUN CI=true npm install -g pnpm@11.5.2 \
 && CI=true npm run build \
 && CI=true node scripts/prepare-tool.mjs \
 && npm prune --omit=dev

# Vendored, sha-verified opencode (the pin lives in opencode.sha256, in-tree).
# Paths are repo-root-relative: the publish workflow builds with context: .
# (the review's P2 — bare filenames would only resolve with a Dockerfile-dir
# context, which this build does not use).
#
# The binary lands at its FINAL path, not staged under /tmp: opencode uses
# `$TMPDIR/opencode` (default /tmp/opencode) as its own runtime directory and
# aborts with `EEXIST: mkdir '/tmp/opencode'` when a file already sits there —
# so `opencode --version` failed and the build failed closed at this step,
# measured in the second local build (2026-10-09). The pin file stages under
# /opt (a path opencode never creates) and `sha256sum -c` resolves the bare
# `opencode` entry against the file in the current directory.
COPY images/control-plane/opencode.sha256 /opt/opencode.sha256
COPY images/control-plane/opencode /usr/local/bin/opencode
RUN chmod 0755 /usr/local/bin/opencode \
 && cd /usr/local/bin \
 && sha256sum -c /opt/opencode.sha256 \
 && opencode --version | grep -q "${OPENCODE_VERSION}"

# Link the package's OWN bins onto the global PATH. `npm ci` installs
# dependencies but never links the root package's `bin` entries (its own bins
# go to node_modules/.bin only on `npm install <self>`), so the CMD below and
# every operator command had no `workflow-hub` to resolve — the container
# failed `Cannot find module '/workspace/workflow-hub'` (measured 2026-10-09).
# `npm link` links the root package's bins into the global prefix; it runs
# after `npm prune` so the linked dist is the final tree.
RUN npm link --ignore-scripts

# Plane LSP provisioning (the "LSP wire"). opencode v2 disables EVERY language
# server when its `lsp` config key is absent
# (packages/opencode/src/lsp/lsp.ts: `if (!cfg.lsp) "all LSPs are disabled"`),
# and the plane's built-in `typescript` server resolves
# `typescript-language-server` from opencode's own npm cache and `tsserver.js`
# from the WORKSPACE's node_modules — neither exists offline in a fresh pod.
# The plane config therefore OVERRIDES the built-in `typescript` entry with an
# explicit command pointing at these baked, sha-pinned versions
# (src/integrations/plane-lsp.ts), and the launch env pins
# OPENCODE_DISABLE_LSP_DOWNLOAD=1 so an unprovisioned built-in fails closed
# instead of fetching from the network mid-session. The npm global prefix of
# node:22-bookworm-slim is /usr/local, so the bin lands under /usr/local/bin;
# because the contained launch forwards an env block with no ambient PATH, the
# runtime SETS PATH (plane-lsp.ts PLANE_LSP_DEFAULT_PATH) so the server's
# `#!/usr/bin/env node` shebang resolves. Versions are pinned to match
# package.json's `typescript` (^5.9.3) and the language server's stable line;
# test/plane-lsp.test.ts pins the paths against these lines.
RUN npm install -g typescript@5.9.3 typescript-language-server@6.0.2 \
 && typescript-language-server --version

ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /workspace
EXPOSE 4096

# C1 plane (SUPERSESSION 2026-10-09, task 3 of
# docs/ledger/control-plane-c1-deploy-plan.md): the former "honest C1 gap"
# header is closed. This image now runs `workflow-plane`, the supervisor that
# starts the hub authority AND the OpenCode server daemon (contained
# `opencode serve` + authority broker + gateway) and binds the gateway to the
# ingress front door. The reference-container objection (bubblewrap cannot
# create namespaces inside a pod) is answered by the DELEGATED
# container-boundary backend (`src/containment/container-boundary.ts`): the
# pod IS the boundary, and the runtime selects it via the instance-supplied
# `WORKFLOW_CONTAINMENT_BACKEND=container-boundary` (never baked here).
#
# The instance sets the state root to the Azure Files mount
# (`WORKFLOW_OPENCODE_SERVER_HOME`); it is NEVER baked here (spec §5: no
# instance values in the open image). The default (~/.workflow) is pre-created
# for `USER node` so the daemon can write discovery without a root-owned dir.
RUN mkdir -p /home/node/.workflow && chown -R node:node /home/node /workspace

# D6: run as the unprivileged `node` user (the base image provides it); no
# process needs root at runtime.
USER node

CMD ["workflow-plane"]
