# Contributing to vm0

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vm0-ai/vm0?quickstart=1)

## Development Setup

This project uses [Dev Containers](https://containers.dev/) for development. The dev container includes all required dependencies and tools.

### Prerequisites

- [Docker](https://www.docker.com/) (or [OrbStack](https://orbstack.dev/) for macOS, recommended)
- [VS Code](https://code.visualstudio.com/) with [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- [mkcert](https://github.com/FiloSottile/mkcert) for local SSL certificates

### SSL Certificates and Hosts Configuration

Before opening the project in VS Code, you need to set up SSL certificates and hosts on your **host machine** (the machine running Docker, not inside the container).

#### 1. Install mkcert

**macOS:**
```bash
brew install mkcert
```

**Linux:**
```bash
# Debian/Ubuntu
sudo apt install mkcert

# Arch Linux
sudo pacman -S mkcert
```

#### 2. Generate SSL Certificates

Run the certificate generation script from the project root on your host machine:

```bash
cd /path/to/vm0
bash scripts/generate-certs.sh
```

This script uses mkcert to create locally-trusted SSL certificates for development.

#### 3. Configure Hosts File

Add the following entries to `/etc/hosts`:

```bash
sudo vim /etc/hosts
# or
sudo nano /etc/hosts
```

Add these lines:

```
127.0.0.1 vm7.ai www.vm7.ai docs.vm7.ai platform.vm7.ai storybook.vm7.ai
```

### Getting Started

1. Fork and clone the repository
2. Open VS Code and run `Dev Containers: Open Workspace in Container` from the command palette
3. Select the `vm0.code-workspace` file in the project root
4. The container will build and set up the development environment automatically
5. Initialize git hooks: `lefthook install`

### Environment Variables

#### For VM0 Team Members

Run the sync script to populate environment variables from 1Password:

```bash
scripts/sync-env.sh
```

#### For Community Contributors

Create the following `.env.local` files manually:

**`turbo/apps/web/.env.local`:**

| Variable | Required | Service |
|----------|----------|---------|
| `CLERK_SECRET_KEY` | Yes | [Clerk](https://dashboard.clerk.com) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | [Clerk](https://dashboard.clerk.com) |
| `E2B_API_KEY` | Yes | [E2B](https://e2b.dev/dashboard) |
| `R2_ACCOUNT_ID` | Yes | [Cloudflare R2](https://dash.cloudflare.com) |
| `R2_ACCESS_KEY_ID` | Yes | [Cloudflare R2](https://dash.cloudflare.com) |
| `R2_SECRET_ACCESS_KEY` | Yes | [Cloudflare R2](https://dash.cloudflare.com) |
| `R2_USER_STORAGES_BUCKET_NAME` | Yes | Create bucket in Cloudflare |

**`turbo/apps/platform/.env.local`:**

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes | Same as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `VITE_API_URL` | Yes | Use `http://localhost:3000` |

### Local Web Development

To run the web application locally with HTTPS:

1. **Ensure SSL certificates and hosts are configured** (see [SSL Certificates and Hosts Configuration](#ssl-certificates-and-hosts-configuration) above)

2. **Start the dev server** (inside dev container):
   ```bash
   cd turbo && pnpm install && pnpm dev
   ```

3. **Access the application**:
   Open https://vm7.ai:8443/ in your browser.

### Local Testing

Run tests inside the dev container:

```bash
cd turbo && pnpm install && pnpm test
```

## Pull Request Process

1. Create a new branch from `main`
2. Make your changes
3. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/) format
4. Push your branch and create a pull request
