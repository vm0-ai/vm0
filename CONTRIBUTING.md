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

Run the sync script to populate environment variables from `.env.local.tpl` templates:

```bash
scripts/sync-env.sh
```

The script will ask if you have 1Password access:
- **VM0 team members**: Choose yes to auto-sync from 1Password
- **Community contributors**: Choose no to enter values interactively (only missing values are prompted)

`SECRETS_ENCRYPTION_KEY` is auto-generated if you press Enter when prompted.

**Required services for the web app (`turbo/apps/web`):**

| Variable | Service |
|----------|---------|
| `CLERK_SECRET_KEY` | [Clerk](https://dashboard.clerk.com) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | [Clerk](https://dashboard.clerk.com) |
| `E2B_API_KEY` | [E2B](https://e2b.dev/dashboard) |
| `R2_ACCOUNT_ID` | [Cloudflare R2](https://dash.cloudflare.com) |
| `R2_ACCESS_KEY_ID` | [Cloudflare R2](https://dash.cloudflare.com) |
| `R2_SECRET_ACCESS_KEY` | [Cloudflare R2](https://dash.cloudflare.com) |
| `R2_USER_STORAGES_BUCKET_NAME` | Create bucket in Cloudflare |
| `SLACK_CLIENT_ID` | [Slack API](https://api.slack.com/apps) |
| `SLACK_CLIENT_SECRET` | [Slack API](https://api.slack.com/apps) |
| `SLACK_SIGNING_SECRET` | [Slack API](https://api.slack.com/apps) |

> **Troubleshooting**: If you see `❌ Invalid environment variables` when running `pnpm dev`, re-run `scripts/sync-env.sh` to fill in the missing values.

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
