# VM0 Development Container

This development container provides a fully configured development environment for the VM0 monorepo.

## Features

### Pre-installed Tools
- **Node.js 22** with pnpm
- **PostgreSQL 17** database
- **GitHub CLI** for PR operations
- **Vercel CLI** for deployments
- **Development tools**: vim, ripgrep, zsh, mkcert

### VSCode Extensions
Automatically installed extensions:
- ESLint & Prettier for code quality
- Tailwind CSS IntelliSense
- Prisma for database management
- TypeScript tooling
- Vitest test explorer
- GitHub Copilot (if you have access)

## Quick Start

1. **Open in Dev Container**
   - Install the "Dev Containers" extension in VSCode
   - Click "Reopen in Container" when prompted
   - Or use Command Palette: `Dev Containers: Reopen in Container`

2. **Start Development**
   ```bash
   cd turbo
   pnpm dev    # Starts all apps in development mode
   ```

3. **Access Applications**
   - Web App: http://localhost:3000
   - Docs: http://localhost:3001
   - Database: postgresql://postgres:postgres@localhost:5432/postgres

## Container Images

We provide two container images:
- **`ghcr.io/vm0-ai/vm0-toolchain:main`** - CI/CD environment (lightweight)
- **`ghcr.io/vm0-ai/vm0-dev:main`** - Development environment (full featured)

## Available Commands

```bash
# Development
pnpm dev          # Start all apps in dev mode
pnpm dev:web      # Start web app only
pnpm dev:docs     # Start docs only

# Testing
pnpm test         # Run all tests
pnpm test:watch   # Run tests in watch mode

# Building
pnpm build        # Build all apps
pnpm build:web    # Build web app
pnpm build:docs   # Build docs

# Code Quality
pnpm lint         # Run ESLint
pnpm format       # Format with Prettier
pnpm typecheck    # TypeScript type checking

# Database
pnpm db:generate  # Generate Prisma client
pnpm db:push      # Push schema to database
pnpm db:studio    # Open Prisma Studio
```

## Persistent Storage

The following directories are persisted across container rebuilds:
- `/home/vscode/.config` - Configuration files
- `/home/vscode/.cache` - Cache files
- `/home/vscode/.local/share/com.vercel.cli` - Vercel auth

## Environment Variables

Pre-configured environment variables:
- `DATABASE_URL`: PostgreSQL connection string
- `NODE_ENV`: Set to "development"

## Troubleshooting

### Database Connection Issues
If you can't connect to the database, ensure PostgreSQL is running:
```bash
sudo service postgresql status
sudo service postgresql start
```

### Permission Issues
The setup script automatically fixes permissions, but if needed:
```bash
sudo chown -R vscode:vscode /home/vscode
```

### Rebuild Container
If you need to rebuild the container:
1. Command Palette: `Dev Containers: Rebuild Container`
2. Or: `Dev Containers: Rebuild and Reopen in Container`

## Customization

To customize your dev container:
1. Edit `.devcontainer/devcontainer.json`
2. Add extensions to the `extensions` array
3. Modify settings in the `settings` object
4. Rebuild the container for changes to take effect