# Control-plane image, FIRST CUT (W149, 2026-09-26): packages the Workflow
# toolchain and a VENDORED stock opencode. Honest status: this Dockerfile has
# NOT been built yet (the authoring environment has no docker); the first
# tagged publish run is its verification, and the C-track's C1 milestone
# (2026-09-25 spec) is expected to refine the in-container composition (hub +
# gateway + broker + served opencode). It carries no work-specific values —
# the instance seeds from it (spec §5).
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
RUN corepack enable && npm ci --ignore-scripts

# Build the product, build the vendored toolbox, then shed devDependencies.
COPY src tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY mcp-toolbox ./mcp-toolbox
COPY assets ./assets
RUN npm run build \
 && node scripts/prepare-tool.mjs \
 && npm prune --omit=dev

# Vendored, sha-verified opencode (the pin lives in opencode.sha256, in-tree).
COPY opencode.sha256 /tmp/opencode.sha256
COPY opencode /tmp/opencode
RUN cd /tmp \
 && sha256sum -c opencode.sha256 \
 && install -m 0755 opencode /usr/local/bin/opencode \
 && opencode --version | grep -q "${OPENCODE_VERSION}"

ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /workspace
EXPOSE 4096

# C1 refines the in-container composition (hub + gateway + broker + served
# opencode); the hub daemon is the current long-running entry.
CMD ["workflow-hub"]