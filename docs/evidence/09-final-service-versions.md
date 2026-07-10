# Service versions

Captured 2026-07-10.

| Component | Local Mac | Hetzner VPS |
| --- | --- | --- |
| CPU architecture | arm64 | x86_64 / linux-amd64 |
| Container engine | OrbStack Docker 29.4.0 | Rootless Docker 29.6.1 |
| Docker Compose | 5.1.2 | 5.3.1 |
| Docker Buildx | 0.33.0 | installed with Docker Engine |
| Host OS | macOS 26.5.1 | Ubuntu 26.04 LTS |
| Gateway | local acceptance build | systemd service on 127.0.0.1:8081 |

Production images built on Hetzner:

- `gptdev-runner-node:local`
- `gptdev-runner-python:local`
- `gptdev-runner-browser:local`

The `:local` labels identify host-local deployment images; they are not pulled from a public registry.
