# Vm0 Stack

A modern, production-ready monorepo template featuring TypeScript, Next.js, and automated CI/CD with comprehensive deployment tracking.

## 🚀 Quick Start

To create a new project from this template, copy and paste the following prompt to your preferred coding AI assistant:

```
I want to create a new project based on the Vm0 monorepo template. Please help me set up everything automatically.

Here's what I need you to do:
1. First, verify GitHub CLI installation and authentication:
   - Check if `gh` is installed by running `gh --version`
   - If not installed, provide installation instructions:
     - macOS: `brew install gh`
     - Windows: `winget install --id GitHub.cli` or download from https://cli.github.com/
     - Linux: Follow instructions at https://github.com/cli/cli#installation
   - Check authentication status with `gh auth status`
   - If not authenticated, guide through: `gh auth login`
   - Only proceed after confirming successful authentication
2. Ask me for my GitHub username and the new project name
3. Ask me for all the required tokens and secrets (tell me where to get each one)
4. Use GitHub CLI to create a new repository from the vm0 template
5. Use Vercel API to create web and docs projects automatically
6. Set up all repository secrets and variables using GitHub CLI
7. Replace all "vm0" references in the code with my project name
8. If NPM_TOKEN is not provided, remove CLI package and related configurations:
   - Delete turbo/apps/cli directory
   - Remove CLI-related jobs from .github/workflows/turbo.yml and .github/workflows/release-please.yml
   - Remove CLI-related configurations from lefthook.yml and other config files
9. Install dependencies and initialize git repository: `(cd turbo && pnpm install) && (git add . && git commit -m "init commit" && git push)
10. Guide me through any additional setup steps

Required GitHub repository secrets (use `gh secret set`):
- NEON_API_KEY (get from: https://console.neon.tech/app/settings/api-keys)
- VERCEL_TOKEN (get from: https://vercel.com/account/tokens)
- DATABASE_URL (production database connection string from Neon)

Optional GitHub repository secrets (only if you want to publish CLI package):
- NPM_TOKEN (get from: https://www.npmjs.com/settings/tokens) - if not provided, CLI package will be removed

Required GitHub repository variables (use `gh variable set`):
- NEON_PROJECT_ID (from your Neon project dashboard)
- VERCEL_TEAM_ID (from Vercel team settings, leave empty for personal account)
- VERCEL_PROJECT_ID_WEB (will be auto-created via Vercel API)
- VERCEL_PROJECT_ID_DOCS (will be auto-created via Vercel API)

Template repository: https://github.com/e7h4n/vm0

Use Vercel API to automatically create:
- Web project: POST https://api.vercel.com/v11/projects with configuration:
  {
    "name": "{project-name}-web",
    "rootDirectory": "turbo/apps/web",
    "buildCommand": "turbo build",
    "framework": "nextjs",
    "commandForIgnoringBuildStep": "echo 'Ignored Build Step - builds are handled by GitHub Actions'"
  }
- Docs project: POST https://api.vercel.com/v11/projects with configuration:
  {
    "name": "{project-name}-docs", 
    "rootDirectory": "turbo/apps/docs",
    "buildCommand": "turbo build",
    "framework": "nextjs",
    "commandForIgnoringBuildStep": "echo 'Ignored Build Step - builds are handled by GitHub Actions'"
  }
- Get project IDs from responses and set as VERCEL_PROJECT_ID_WEB and VERCEL_PROJECT_ID_DOCS

Please guide me through this process step by step, asking for one piece of information at a time and explaining what each token is used for.
```

After pasting this prompt, your coding AI will automatically:

- Verify GitHub CLI installation and authentication status
- Create the repository from this template
- Set up Vercel projects for web and docs with proper monorepo configuration
- Configure all required secrets and environment variables
- Replace project names throughout the codebase
- Optionally remove CLI package and related configurations (if NPM_TOKEN not provided)
- Install dependencies (pnpm install) and initialize git repository with commit and push
- Set up the complete CI/CD pipeline

## 🚀 Features

- **Type-Safe Monorepo**: Full TypeScript support with strict type checking across all packages
- **Modern Stack**: Next.js 15, React 19, Drizzle ORM, and Neon Database
- **Advanced CI/CD**: Automated builds, testing, and deployments with GitHub deployment tracking
- **Multi-Environment**: Preview environments for PRs with isolated database branches
- **Developer Experience**: Hot reload, comprehensive testing, and development containers

## 📁 Project Structure

```
turbo/
├── apps/
│   ├── cli/           # CLI tool (published to NPM)
│   ├── web/           # Next.js web application
│   └── docs/          # Documentation site (Fumadocs)
├── packages/
│   ├── core/          # Shared utilities and types
│   ├── ui/            # Reusable UI components
│   ├── eslint-config/ # ESLint configuration
│   └── typescript-config/ # TypeScript configuration
└── e2e/               # End-to-end tests
```

## 🛠 Applications

### Web Application (`apps/web`)
- **Framework**: Next.js 15 with React 19
- **Database**: Neon PostgreSQL with Drizzle ORM
- **Deployment**: Vercel with preview environments
- **Features**: Server-side rendering, API routes, database migrations

### CLI Tool (`apps/cli`)
- **Build**: TSup for fast TypeScript compilation
- **Distribution**: NPM package with binary executable
- **Features**: Commander.js for CLI interface, Chalk for styling

### Documentation (`apps/docs`)
- **Framework**: Fumadocs for modern documentation
- **Features**: MDX support, auto-generated navigation, search

## 🏗 Development

### Prerequisites
- Node.js 20+
- pnpm 9+

### Getting Started

```bash
# Install dependencies
cd turbo && pnpm install

# Start development servers
pnpm dev

# Run tests
pnpm test

# Run linting
pnpm lint

# Type checking
pnpm check-types
```

### Database Setup

```bash
# Generate migration files
cd turbo/apps/web && pnpm db:generate

# Run migrations
pnpm db:migrate

# Open Drizzle Studio
pnpm db:studio
```

## 🚀 Deployment

### Automated CI/CD
- **GitHub Actions**: Automated testing, building, and deployment
- **Preview Environments**: Automatic PR deployments with isolated database branches
- **Release Management**: Automated releases with release-please
- **Multi-Platform Testing**: Ubuntu and macOS E2E testing

### 🔄 Development Workflow

#### Pull Request Workflow
When you create a pull request, the following happens automatically:

1. **🗃️ Database Branch Creation**: 
   - A new Neon database branch is created with the name `preview/{branch-name}`
   - Database migrations are applied to the new branch
   - A unique database connection string is generated

2. **🌐 Preview Environment Deployment**:
   - Web and docs applications are built and deployed to Vercel preview environments
   - Each deployment gets a unique URL: `{project-name}-web-{branch}.vercel.app`
   - Preview environments use the isolated database branch

3. **📊 Deployment Status**:
   - All deployment statuses are tracked and visible in the PR
   - Links to preview environments and database console are provided
   - GitHub deployment status shows: `web/preview/{branch}`, `docs/preview/{branch}`, `neon/preview/{branch}`

#### Production Release Workflow
Production deployments follow a controlled release process:

1. **🔀 PR Merge**: When your feature PR is merged to `main`, no automatic production deployment occurs

2. **📋 Release PR Creation**: 
   - `release-please` bot automatically creates or updates a release PR
   - The release PR contains version bumps and changelog updates
   - Multiple feature merges accumulate in a single release PR

3. **🚀 Production Release**: When the release PR is merged:
   - **Version Update**: Package versions are bumped according to conventional commits
   - **Database Migration**: Production database migrations are applied
   - **Vercel Deployment**: Web and docs apps are deployed to production
   - **NPM Publishing**: CLI package is published to NPM (if configured)
   - **GitHub Release**: A new GitHub release is created with changelog

This workflow ensures:
- ✅ Safe, controlled production deployments
- ✅ Proper version management and changelog generation
- ✅ Database migration safety with preview branches
- ✅ No accidental production deployments from feature branches

### Environment Configuration

#### Repository Secrets
- `NEON_API_KEY`: Neon database API key
- `NPM_TOKEN`: NPM publishing token
- `VERCEL_TOKEN`: Vercel deployment token
- `DATABASE_URL`: Production database connection string

#### Repository Variables  
- `NEON_PROJECT_ID`: Neon database project ID
- `VERCEL_PROJECT_ID_WEB`: Vercel project ID for web app (auto-created via API)
- `VERCEL_PROJECT_ID_DOCS`: Vercel project ID for docs (auto-created via API)
- `VERCEL_TEAM_ID`: Vercel team identifier (optional, for team accounts)

### Deployment Targets
- **Web App**: Automatically deployed to Vercel on release
- **CLI Package**: Published to NPM on release (optional, if NPM_TOKEN provided)
- **Documentation**: Deployed to Vercel on release (if configured)

## 🧪 Testing

### Unit Tests
```bash
pnpm test          # Run all tests
pnpm test:watch    # Watch mode
pnpm test:ui       # Interactive UI
```

### E2E Tests
```bash
cd e2e && make test
```

## 🏛 Architecture Principles

### 1. Strict Type Safety
- Zero `any` types allowed
- Comprehensive TypeScript configuration
- Runtime validation with Zod

### 2. Monorepo Benefits
- Shared configurations and dependencies
- Consistent code quality across packages
- Efficient build caching with Turbo

### 3. Modern Deployment
- Preview environments for every PR
- Database branching for isolation
- Comprehensive deployment tracking

### 4. Developer Experience
- Fast hot reload with Turbopack
- Container-based development
- Automated code formatting and linting

## 🔄 CI/CD Architecture

This project uses an optimized GitHub Actions workflow architecture aligned with production best practices:

### Performance Optimizations
- **Reusable Actions**: `toolchain-init` action eliminates code duplication across jobs
- **Smart Checkout**: `fetch-depth: 2` for faster git operations
- **Parallel Execution**: Lint and test run independently without waiting for change detection
- **No Artifacts**: Direct build-and-deploy eliminates upload/download overhead

### Reliability Improvements
- **Always-Run Checks**: Lint and test execute unconditionally for consistent quality gates
- **Merge Queue Support**: `merge_group` trigger enables GitHub's merge queue feature
- **Simplified Dependencies**: Reduced job dependency chains minimize failure points

### Developer Experience
- **Lefthook Integration**: Consistent linting between local and CI environments
- **Pre-installed Tools**: Docker images include `neonctl`, `lefthook`, and all dependencies
- **Clear Paths**: Fixed git safe directory configuration for predictable behavior

Result: **30-40% faster CI execution** with improved reliability and maintainability.

## 📦 Package Management

This project uses **pnpm** with workspace protocol for efficient package management and **Turbo** for optimized builds and caching.


## 📄 License

This project is a template - feel free to use it as a starting point for your own projects.
