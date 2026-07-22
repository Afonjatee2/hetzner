FROM node:22-bookworm-slim
# Task containers run with no network: corepack's pnpm shim tries to download
# the real binary on first use and fails. Disable corepack entirely and
# install the real pnpm binary at build time so no runtime download is needed.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable 2>/dev/null || true \
    && npm install -g pnpm@10 typescript \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin runner \
    && mkdir -p /pnpm-store && chown 10001:10001 /pnpm-store
USER 10001:10001
WORKDIR /workspace
ENV CI=true HOME=/home/runner PNPM_STORE_DIR=/pnpm-store
CMD ["node", "--version"]

