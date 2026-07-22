FROM node:22-bookworm-slim
ARG PNPM_VERSION=10.33.2
# Install a real, pinned pnpm binary at image-build time. Task containers often
# run without network access, so pnpm must not download a different version from
# a repository packageManager field when a command starts.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable \
    && npm install -g --force "pnpm@${PNPM_VERSION}" typescript \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin runner \
    && mkdir -p /pnpm-store && chown 10001:10001 /pnpm-store
USER 10001:10001
WORKDIR /workspace
ENV CI=true HOME=/home/runner PNPM_STORE_DIR=/pnpm-store npm_config_manage_package_manager_versions=false
RUN pnpm config set --global manage-package-manager-versions false \
    && test "$(pnpm --version)" = "${PNPM_VERSION}"
CMD ["node", "--version"]
