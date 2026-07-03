# Contributing to vm0

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vm0-ai/vm0?quickstart=1)

## Development Setup

This project uses [Dev Containers](https://containers.dev/) for development. The dev container includes all required dependencies (Node.js, pnpm, PostgreSQL, etc.).

### Prerequisites

- [Docker](https://www.docker.com/) (or [OrbStack](https://orbstack.dev/) for macOS, recommended)
- [VS Code](https://code.visualstudio.com/) with [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

### External Services

You need to register the following services and obtain API keys:

**Required** (dev server won't start without these):

| Service                                                  | Purpose                                     | Keys needed                                                                                 |
| -------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Clerk](https://clerk.com)                               | User authentication and session management  | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`                                                 |
| [Cloudflare R2](https://www.cloudflare.com/products/r2/) | Object storage for user files and artifacts | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_USER_STORAGES_BUCKET_NAME` |

Hosted static sites are optional locally. When enabling them, configure a
separate R2 token with `R2_HOSTED_SITES_BUCKET_NAME`,
`R2_HOSTED_SITES_ACCESS_KEY_ID`, `R2_HOSTED_SITES_SECRET_ACCESS_KEY`,
`ZERO_HOST_DOMAIN`, and `ZERO_HOST_SCHEME`.

All other environment variables (OAuth connectors, Slack, Axiom, etc.) can be
left empty.

### Getting Started

1. Fork and clone the repository
2. Open VS Code and run `Dev Containers: Open Workspace in Container` from the command palette
3. Select the `vm0.code-workspace` file in the project root
4. The container will build and set up the development environment automatically
5. Initialize git hooks: `lefthook install`

### Environment Variables

Create `.env.local` files manually from the `.env.local.tpl` templates:

```bash
# Copy templates
cp turbo/apps/web/.env.local.tpl turbo/apps/web/.env.local
cp turbo/apps/platform/.env.local.tpl turbo/apps/platform/.env.local
```

Then edit the `.env.local` files:

1. Replace `op://...` values for required services (Clerk, Cloudflare R2) with your actual keys
2. For `SECRETS_ENCRYPTION_KEY`, generate one:
   ```bash
   openssl rand -hex 32
   ```
3. For `APP_URL`, use `https://vm7.ai:8443`
4. Leave optional `op://...` values empty if you don't need those integrations

### Running Tests

Inside the dev container:

```bash
cd turbo && pnpm install && pnpm -F web db:migrate && pnpm build && pnpm test
```

- `db:migrate` sets up the local database schema
- `pnpm build` builds shared packages (e.g. `@vm0/core`)

### Running the Dev Server

1. Run the preparation script (installs deps, migrates DB):

   ```bash
   bash scripts/prepare.sh
   ```

2. Start the dev server:

   ```bash
   cd turbo && pnpm dev
   ```

3. Access the application at https://vm7.ai:8443/

### Accessing the Local Database

The dev container includes a PostgreSQL instance:

```bash
psql $DATABASE_URL
```

Useful commands: `\dt` (list tables), `\d tablename` (table schema), `\q` (quit).

## Pull Request Process

1. Create a new branch from `main`
2. Make your changes
3. Commit following [Conventional Commits](https://www.conventionalcommits.org/) format
4. Run quality checks before pushing:
   ```bash
   cd turbo && pnpm turbo run lint && pnpm check-types && pnpm format && pnpm vitest
   ```
5. Push your branch and create a pull request
