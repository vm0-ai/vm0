# @vm0/proxy

Caddy reverse proxy for local HTTPS development.

## Overview

This package provides a Caddy-based reverse proxy that enables HTTPS for local development using mkcert-generated certificates.

## Features

- **HTTPS support** for all local development servers
- **Multiple domains**: www.vm0.dev, docs.vm0.dev
- **Automatic HTTP to HTTPS redirect**
- **WebSocket support** for hot module replacement

## Architecture

```
Browser
  ↓
Caddy Proxy (HTTPS: 8443, HTTP: 8080)
  ↓
┌──────────────┬──────────────┐
│              │              │
Web App        Docs App
(port 3000)    (port 3001)
```

## Quick Start

### 1. Generate Certificates

First time setup:

```bash
cd turbo
pnpm generate-certs
```

This will:

- Install mkcert CA to your system trust store
- Generate SSL certificates for:
  - vm0.dev
  - www.vm0.dev
  - docs.vm0.dev

### 2. Verify Certificates

```bash
cd turbo
pnpm check-certs
```

### 3. Start Development Servers

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

### 4. Access Applications

With HTTPS (via Caddy):

- Web: https://www.vm0.dev:8443
- Docs: https://docs.vm0.dev:8443

Direct access (HTTP only):

- Web: http://localhost:3000
- Docs: http://localhost:3001

## Configuration

### Caddyfile

The `Caddyfile` defines:

- Port configuration (8080 for HTTP, 8443 for HTTPS)
- Domain routing
- TLS certificate paths
- HTTP to HTTPS redirects

### Domain Mapping

| Domain            | Port | Backend                       |
| ----------------- | ---- | ----------------------------- |
| www.vm0.dev:8443  | 8443 | localhost:3000 (Next.js web)  |
| docs.vm0.dev:8443 | 8443 | localhost:3001 (Next.js docs) |
| vm0.dev:8443      | 8443 | Redirect to www.vm0.dev:8443  |

## Scripts

- `pnpm dev` - Start Caddy proxy server
- `pnpm check-certs` - Verify certificates exist
- `pnpm generate-certs` - Generate SSL certificates

## DevContainer Integration

The DevContainer automatically:

- Adds vm0.dev domains to `/etc/hosts`
- Installs mkcert CA to system trust store
- Installs CA to NSS database (for Chrome/Firefox)
- Persists mkcert state across container rebuilds

## Troubleshooting

### Certificates not found

```bash
# Generate certificates
cd turbo
pnpm generate-certs
```

### Caddy won't start

1. Check if certificates exist:

   ```bash
   ls -la ../../.certs/
   ```

2. Check if ports are available:

   ```bash
   lsof -i :8080
   lsof -i :8443
   ```

3. Kill existing Caddy instances:
   ```bash
   pkill -f caddy
   ```

### Browser shows "Not Secure"

The mkcert CA may not be installed. Run:

```bash
mkcert -install
```

Then restart your browser.

### /etc/hosts not configured

In DevContainer, this should be automatic. If not:

```bash
echo "127.0.0.1 vm0.dev www.vm0.dev docs.vm0.dev" | sudo tee -a /etc/hosts
```

## File Structure

```
packages/proxy/
├── Caddyfile              # Caddy configuration
├── package.json           # Package scripts
├── scripts/
│   ├── check-certs.js    # Certificate validation
│   └── start-caddy.js    # Caddy startup script
└── README.md             # This file
```

## Related Files

- `/scripts/generate-certs.sh` - Certificate generation script
- `/.certs/` - Generated certificates (gitignored)
- `/.devcontainer/setup.sh` - DevContainer initialization
- `/.devcontainer/devcontainer.json` - DevContainer config with mkcert mounts

## Why HTTPS for Local Development?

1. **Production parity** - Match production environment
2. **Service Workers** - Required for PWA testing
3. **Secure cookies** - Test secure flag behavior
4. **HTTPS APIs** - Test with real SSL/TLS
5. **No browser warnings** - Clean development experience

## Comparison with HTTP-only Development

| Feature          | With Proxy (HTTPS) | Direct (HTTP)    |
| ---------------- | ------------------ | ---------------- |
| SSL/TLS          | ✅ Yes             | ❌ No            |
| Multiple domains | ✅ Yes             | ❌ No            |
| Production-like  | ✅ Yes             | ⚠️ Partial       |
| Setup complexity | ⚠️ Medium          | ✅ Simple        |
| Browser warnings | ✅ None            | ⚠️ Mixed content |

## License

Private - Part of VM0 monorepo
