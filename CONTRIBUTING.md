# Contributing to vm0

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vm0-ai/vm0?quickstart=1)

## Development Setup

This project uses [Dev Containers](https://containers.dev/) for development. The dev container includes all required dependencies and tools.

### Prerequisites

- [Docker](https://www.docker.com/) (or [OrbStack](https://orbstack.dev/) for macOS, recommended)
- [VS Code](https://code.visualstudio.com/) with [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- [mkcert](https://github.com/FiloSottile/mkcert) for local SSL certificates

**Required SaaS services (community contributors need to register these before running the setup):**

| Service | Purpose | Tokens needed | Dashboard |
|---------|---------|---------------|-----------|
| [Clerk](https://clerk.com) | User authentication and session management | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | [dashboard.clerk.com](https://dashboard.clerk.com) |
| [E2B](https://e2b.dev) | Cloud sandbox runtime for executing agent code | `E2B_API_KEY` | [e2b.dev/dashboard](https://e2b.dev/dashboard) |
| [Cloudflare R2](https://www.cloudflare.com/products/r2/) | Object storage for user files and artifacts | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_USER_STORAGES_BUCKET_NAME` | [dash.cloudflare.com](https://dash.cloudflare.com) |
| [Slack API](https://api.slack.com) | Slack app integration for notifications and commands | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | [api.slack.com/apps](https://api.slack.com/apps) |

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

### Getting Started

1. Fork and clone the repository
2. Open VS Code and run `Dev Containers: Open Workspace in Container` from the command palette
3. Select the `vm0.code-workspace` file in the project root
4. The container will build and set up the development environment automatically
5. Initialize git hooks: `lefthook install`

### Environment Variables

Run the sync script to populate environment variables from `.env.local.tpl` templates:

```bash
scripts/sync-env.sh
```

The script will ask if you have 1Password access:
- **VM0 team members**: Choose yes to auto-sync from 1Password
- **Community contributors**: Choose no to enter values interactively (only missing values are prompted)

`SECRETS_ENCRYPTION_KEY` is auto-generated if you press Enter when prompted.

### Local Web Development

To run the web application locally with HTTPS:

1. **Ensure SSL certificates and hosts are configured** (see [SSL Certificates and Hosts Configuration](#ssl-certificates-and-hosts-configuration) above)

2. **Start the dev server** (inside dev container):
   ```bash
   bash scripts/prepare.sh && cd turbo && pnpm dev
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
