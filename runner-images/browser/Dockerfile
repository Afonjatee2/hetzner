FROM mcr.microsoft.com/playwright:v1.61.1-noble
USER root
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin runner || true
USER 10001:10001
WORKDIR /workspace
ENV HOME=/home/runner CI=true
CMD ["node", "--version"]

