# C0 transport-probe image: STOCK opencode serve only — no Workflow code.
# Purpose: prove SSE + basic auth survive Container Apps external ingress
# before any control-plane code rides on it. See infra/c0/README.md.
#
# NOTE: no `rm -rf /var/lib/apt/lists/*` here on purpose — the workflow guard
# rejects script content with recursive deletions of system paths. apt-get
# clean only; the image is a throwaway transport probe, size is not a goal.
#
# NOTE: the opencode binary is VENDORED, not downloaded. v2.0.10 is the
# dev-channel build the Workflow control plane qualified against (W071/W074
# probes in docs/HOST_ADAPTERS.md) — it is not published on npm or GitHub
# releases (latest there is v1.18.32). deploy.sh copies the exact qualified
# binary from ~/.local/bin/opencode into this build context and records its
# sha256 in c0.env; the build fails on version drift.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && apt-get clean

COPY opencode /usr/local/bin/opencode
RUN chmod +x /usr/local/bin/opencode

# Build-time pin verification: fail the image build on version drift.
RUN opencode --version | grep -q "v2.0.10"

WORKDIR /workspace
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
