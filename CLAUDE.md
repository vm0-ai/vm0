# Claude Code Project Guidelines

## Development Environment

**Claude Code runs in an isolated Docker container** with its own PostgreSQL server. This environment is completely separate from production.

### Key Assumptions

- **main branch is always stable** - All code merged to main has passed CI (build + tests). If your branch fails to build or pass tests, the issue is in your branch code, not main.
- **Use dev-tunnel for local development** - Run `/dev-tunnel` to start a local server accessible by sandbox webhooks. Without this, webhooks cannot reach your local server.
- **Run `pnpm db:migrate` to sync database** - After pulling new changes, run this command in the `turbo` directory to apply the latest migrations.
- **Run `script/sync-env.sh` to sync environment variables** - If missing required environment variables, ask the user to run this script to sync `.env.local`.

## Global Services Pattern

### How to Use Services

We use a simple global services pattern for managing singletons like database connections:

```typescript
// In any API route or server component
import { initServices } from "../lib/init-services";

export async function GET() {
  // Initialize services at entry point (idempotent - safe to call multiple times)
  initServices();
  
  // Access services directly from globalThis
  const users = await globalThis.services.db.select().from(users);
  const env = globalThis.services.env;
  
  return NextResponse.json({ users });
}
```

### Key Points

- **Always call `initServices()` at the entry point** - This ensures services are initialized
- **Services are lazy-loaded** - Database connections are only created when first accessed
- **No cleanup needed** - Serverless functions handle cleanup automatically
- **Type-safe** - Full TypeScript support via global type declarations

### Available Services

- `globalThis.services.env` - Validated environment variables
- `globalThis.services.db` - Drizzle database instance
- `globalThis.services.pool` - PostgreSQL connection pool

## Architecture Design Principles

### YAGNI (You Aren't Gonna Need It)
**This is a core principle for this project.** We follow the YAGNI principle strictly to keep the codebase simple and maintainable.

#### What this means:
- **Don't add functionality until it's actually needed**
- **Start with the simplest solution that works**
- **Avoid premature abstractions**
- **Delete unused code aggressively**

#### Examples in this project:
- Test helpers should only include functions that are actively used
- Configuration files should start minimal and grow as needed
- Avoid creating "utility" functions for single use cases
- Don't add "just in case" parameters or options

### Avoid Defensive Programming
**Let exceptions propagate naturally.** Don't wrap everything in try/catch blocks.

#### What this means:
- **Only catch exceptions when you can meaningfully handle them**
- **Let errors bubble up to where they can be properly addressed**
- **Avoid defensive try/catch blocks that just log and re-throw**
- **Trust the runtime and framework error handling**

#### Examples in this project:
- Database operations should fail fast if connection is broken
- File operations should naturally throw if permissions are wrong
- Don't wrap every async operation in try/catch
- Only use try/catch when you have specific error recovery logic

### Strict Type Checking
**Maintain type safety throughout the codebase.** Never compromise on type checking.

#### What this means:
- **Absolutely no use of `any` type**
- **Always provide explicit types where TypeScript can't infer**
- **Use proper type narrowing instead of type assertions**
- **Define interfaces and types for all data structures**

#### Examples in this project:
- All function parameters must have explicit types
- API responses should have defined interfaces
- Avoid `as` casting unless absolutely necessary
- Use `unknown` instead of `any` when type is truly unknown

### Zero Tolerance for Lint Violations
**All code must pass linting without exceptions.** Maintain code quality standards consistently.

#### What this means:
- **Never add eslint-disable comments**
- **Never add @ts-ignore or @ts-nocheck**
- **Fix the underlying issue, don't suppress the warning**
- **All lint rules are there for a reason - respect them**

#### Examples in this project:
- If a lint rule is triggered, refactor the code to comply
- Don't disable rules in configuration files
- Address TypeScript errors properly, don't ignore them
- Unused variables should be removed, not ignored

### Testing Guidelines
**"Write tests. Not too many. Mostly integration."** — Kent C. Dodds

#### Core Rules:
- **Integration Tests Only** - Test at entry points (CLI commands, API routes), not internal functions
- **No Unit Tests** - Integration tests already exercise all internal logic
- **E2E Tests for Happy Path** - E2E tests only cover happy path; error cases go in integration tests
- **Only Mock External Dependencies** - If `vi.mock()` path starts with `../../`, it's wrong
- **Use Real Infrastructure** - Real database, real filesystem (temp dirs), MSW for HTTP

For detailed patterns and examples, use `/testing`.

## Commit Message Guidelines

**All commit messages must follow Conventional Commits format.** This ensures consistent commit history and enables automated versioning.

### Format
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Required Rules:
- **Type must be lowercase** - Use `feat:`, not `Feat:` or `FEAT:`
- **Description must start with lowercase** - Use `add new feature`, not `Add new feature`  
- **No period at the end** - Use `fix user login`, not `fix user login.`
- **Keep title under 100 characters** - Ensure the entire first line is concise
- **Use imperative mood** - Use `add`, not `added` or `adds`

### Types:
- `feat:` New feature
- `fix:` Bug fix  
- `docs:` Documentation changes
- `style:` Code style changes (formatting, semicolons, etc)
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Build process or auxiliary tool changes
- `ci:` CI configuration changes
- `perf:` Performance improvements
- `build:` Build system changes
- `revert:` Revert previous commit

### Examples:
- ✅ `feat: add user authentication system`
- ✅ `fix: resolve database connection timeout`
- ✅ `docs(api): update endpoint documentation`
- ✅ `ci: optimize release workflow dependencies`
- ❌ `Fix: Resolve database connection timeout.` (wrong case, has period)
- ❌ `added user auth` (missing type, wrong tense)
- ❌ `feat: Add user authentication system with OAuth2 integration, JWT tokens, refresh mechanism, and comprehensive error handling` (too long)

## Pre-Commit Checks

**All code must pass these checks before committing.** Run these commands from the `/turbo` directory to ensure code quality:

### Required Checks:
- **Lint:** `cd turbo && pnpm turbo run lint` - Check for code style and quality issues
- **Type Check:** `cd turbo && pnpm check-types` - Verify TypeScript type safety
- **Format:** `cd turbo && pnpm format` - Auto-format code according to project standards
- **Test:** `cd turbo && pnpm vitest` - Run all tests to ensure functionality
- **Knip:** `cd turbo && pnpm knip` - Find and fix unused dependencies, exports, and files

### Before Committing:
1. Run all checks to ensure code quality
2. Fix any issues that are found
3. Never commit code that fails any of these checks
4. Use proper conventional commit message format
5. These checks help maintain the high standards defined in our design principles

## Code Quality Tools

### Knip - Dependency and Export Analysis

**Knip is integrated to maintain a clean and efficient codebase.** It identifies unused files, dependencies, and exports across the monorepo.

#### Available Commands:
- `pnpm knip` - Run full analysis to find unused code
- `pnpm knip:fix` - Automatically fix issues (removes unused files and dependencies)
- `pnpm knip:production` - Strict production mode analysis
- `pnpm knip --workspace <name>` - Analyze specific workspace only

#### Configuration:
- Configuration file: `turbo/knip.json`
- Workspace-specific settings for each package
- Integrated with lefthook pre-commit hooks

#### Common Issues and Solutions:
- **Unused dependencies:** Review and remove from package.json
- **Unused exports:** Delete or mark as internal if needed
- **Unused files:** Remove if truly unused, or add to entry patterns if needed
- **False positives:** Add to ignore patterns in knip.json

## PR Checks

**All pull requests must pass CI checks before merging.** These checks are defined in `.github/workflows/turbo.yml` and run automatically on every PR, including lint, test, deploy, and cli-e2e.

### Zero Tolerance for Skipping Tests

**NEVER skip tests to make CI pass.** All tests must execute and pass:
- Do not add `skip` flags or environment variables to bypass tests
- Do not modify CI workflow to skip tests that are timing out or failing
- If tests are slow or timing out, **fix the underlying issue** - either optimize the tests or fix the code
- The purpose of tests is to validate functionality - skipping them defeats that purpose
- Especially critical: **never skip tests for the feature being developed in the PR**

If tests timeout, investigate why:
1. Is there a bug in the code causing infinite loops or hangs?
2. Are there network issues or external service dependencies?
3. Is the test itself poorly designed and needs optimization?

### CLI E2E Timeout

The `cli-e2e` jobs have a **maximum timeout** (5 minutes for serial/parallel tests, 8 minutes for runner tests). If tests exceed this limit, GitHub Actions will **cancel** the job (not fail). **Cancelled status is NOT acceptable for merge** - treat it as a failure and investigate the cause.

### Merge Requirements

- All required checks must show **green (passed)**
- "Cancelled" status does **not** satisfy the requirement

## Language Standard

**All project artifacts must be written in English,** but direct communication with users should use the user's preferred language.

### English Required For:
- **Source code** - Variable names, function names, class names
- **Comments** - Inline comments and documentation comments
- **Commit messages** - All git commit messages
- **Pull requests** - PR titles, descriptions, and review comments
- **Issues** - Bug reports, feature requests, and discussions
- **Documentation** - README, guides, and all markdown files

### User Communication:
- **Use the user's language** - When communicating directly with users, respond in their language
- **Language priority** - If the user uses multiple languages, prioritize them in this order: user's primary language(s) first, English last
- **Consistency** - Once you identify the user's preferred language, maintain that language throughout the conversation

