# Control-plane image (W149, 2026-09-26; first LOCAL build + fixes 2026-10-09):
# packages the Workflow toolchain and a VENDORED stock opencode. Honest status:
# the image now BUILDS (verified with podman, 2026-10-09) and the CMD resolves;
# the C-track's C1 milestone (2026-09-25 spec) in-container composition
# (hub + gateway + broker + served opencode) is NOT yet composed — see the
# C1 gap note at the CMD below and docs/ledger/control-plane-c1-composition.md.
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

ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /workspace
EXPOSE 4096

# The long-running entry is the hub daemon (the authority every surface
# resolves). HONEST C1 GAP (2026-10-09): this single-process image is NOT the
# full C1 plane. C1 (2026-09-25 spec §8/§10) composes hub + opencode-server
# daemon + gateway + broker + a CONTAINED `opencode serve` in one container,
# with the gateway as the single ingress front door on 4096. That composition
# is not implemented here and was not implementable in the reference
# container: `createOpencodeServerRuntime` launches `opencode serve` through
# `launchContainedAcpAgent`, which REQUIRES an `enforced` containment boundary
# (`src/adapters/acp-contained-agent.ts:63`), and bubblewrap cannot create the
# namespaces inside the container (measured: `bwrap: Creating new namespace
# failed: Operation not permitted`, even with `bubblewrap` installed). No
# same-process single-port supervisor over {hub, gateway, serve} exists in the
# repo. See docs/ledger/control-plane-c1-composition.md for the decision,
# evidence, and the two candidate implementations (SupervisorContainment vs a
# two-replica / two-container split) for the operator. This image is therefore
# a QUALIFIED PARTIAL artifact: the hub authority runs (on an EPHEMERAL loopback
# port from the discovery file — it does NOT serve 4096), and NOTHING answers on
# 4096 yet. It is NOT a deployable C1 plane, and csh-dev must not deploy it as
# one.
CMD ["workflow-hub"]
