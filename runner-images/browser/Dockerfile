FROM mcr.microsoft.com/playwright:v1.61.1-noble
USER root
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin runner || true
RUN npm install --global --omit=dev playwright@1.61.1
USER 10001:10001
WORKDIR /workspace
ENV HOME=/home/runner CI=true
CMD ["node", "--version"]
