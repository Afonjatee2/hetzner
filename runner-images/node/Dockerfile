FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin runner
USER 10001:10001
WORKDIR /workspace
ENV CI=true HOME=/home/runner
CMD ["node", "--version"]

