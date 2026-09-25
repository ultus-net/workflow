# C0 transport-probe image: STOCK opencode serve only — no Workflow code.
# Purpose: prove SSE + basic auth survive Container Apps external ingress
# before any control-plane code rides on it. See infra/c0/README.md.
#
# NOTE: no `rm -rf /var/lib/apt/lists/*` here on purpose — the workflow guard
# rejects script content with recursive deletions of system paths. apt-get
# clean only; the image is a throwaway transport probe, size is not a goal.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=2.0.10

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && apt-get clean

# Stock standalone binary, pinned to the version the Workflow control plane
# qualified against (docs/HOST_ADAPTERS.md v2.0.10 verdicts).
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION} \
 && mv "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode \
 && chmod +x /usr/local/bin/opencode

# Build-time pin verification: fail the image build on version drift.
RUN opencode --version | grep -q "v${OPENCODE_VERSION}"

WORKDIR /workspace
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
