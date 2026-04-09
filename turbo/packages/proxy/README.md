# @vm0/proxy

Caddy reverse proxy for local HTTPS development with automatic Let's Encrypt certificates.

## Overview

This package provides a Caddy-based reverse proxy that enables HTTPS for local development. Certificates are automatically provisioned via Let's Encrypt using DNS-01 challenge against Cloudflare.

## Features

- **Automatic HTTPS** via Let's Encrypt (no manual certificate management)
- **Multiple domains**: www.vm7.ai, app.vm7.ai
- **Automatic HTTP to HTTPS redirect**
- **WebSocket support** for hot module replacement
- **Shared certificate cache** across devcontainers via Docker volume

## Architecture

```
Browser
  ↓
Caddy Proxy (HTTPS: 8443, HTTP: 8080)
  ↓              ↓
Web App        App
(port 3000)    (port 3002)
```

## Quick Start

### 1. Sync Environment (requires 1Password)

```bash
scripts/sync-env.sh
```

This provisions `CF_DNS_AND_TUNNEL_API_TOKEN` needed for Let's Encrypt DNS-01 challenge.

### 2. Start Development Servers

**Terminal 1 - Start applications:**

```bash
cd turbo
pnpm dev
```

**Terminal 2 - Start Caddy proxy:**

```bash
cd turbo/packages/proxy
pnpm dev
```

On first start, Caddy will automatically obtain a Let's Encrypt certificate (~30s). Subsequent starts use the cached certificate.

### 3. Access Applications

- Web: https://www.vm7.ai:8443
- App: https://app.vm7.ai:8443

Direct access (HTTP only):

- Web: http://localhost:3000
- App: http://localhost:3002

## Configuration

### Caddyfile

The `Caddyfile` defines:

- Port configuration (8080 for HTTP, 8443 for HTTPS)
- Domain routing with automatic TLS via Cloudflare DNS challenge
- Certificate storage at `~/.local/certs/caddy`
- HTTP to HTTPS redirects

### Domain Mapping

| Domain          | Port | Backend                      |
| --------------- | ---- | ---------------------------- |
| www.vm7.ai:8443 | 8443 | localhost:3000 (Next.js web) |
| app.vm7.ai:8443 | 8443 | localhost:3002 (Vite app)    |
| vm7.ai:8443     | 8443 | Redirect to www.vm7.ai:8443  |

## Scripts

- `pnpm dev` - Start Caddy proxy server

## Troubleshooting

### Caddy won't start — missing CF_DNS_AND_TUNNEL_API_TOKEN

Run `scripts/sync-env.sh` to provision the Cloudflare DNS token from 1Password.

### Caddy won't start — port conflict

```bash
lsof -i :8080
lsof -i :8443
pkill -f caddy
```

### /etc/hosts not configured

In DevContainer, this should be automatic. If not:

```bash
echo "127.0.0.1 vm7.ai www.vm7.ai app.vm7.ai" | sudo tee -a /etc/hosts
```

## File Structure

```
packages/proxy/
├── Caddyfile              # Caddy configuration
├── package.json           # Package scripts
├── scripts/
│   └── start-caddy.js    # Caddy startup script
└── README.md             # This file
```

## License

Private - Part of VM0 monorepo
