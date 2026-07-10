FROM python:3.13-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin runner
RUN pip install --no-cache-dir pytest==8.4.1 ruff==0.12.3 mypy==1.16.1
USER 10001:10001
WORKDIR /workspace
ENV HOME=/home/runner PYTHONDONTWRITEBYTECODE=1
CMD ["python", "--version"]

