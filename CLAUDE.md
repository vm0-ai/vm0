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

### Before Committing:
1. Run all checks to ensure code quality
2. Fix any issues that are found
3. Never commit code that fails any of these checks
4. Use proper conventional commit message format
5. These checks help maintain the high standards defined in our design principles

## Language Standard

**All project content must be written in English.** This ensures accessibility for international contributors and maintains consistency across the codebase.

### Applies to:
- **Source code** - Variable names, function names, class names
- **Comments** - Inline comments and documentation comments
- **Commit messages** - All git commit messages
- **Pull requests** - PR titles, descriptions, and review comments
- **Issues** - Bug reports, feature requests, and discussions
- **Documentation** - README, guides, and all markdown files
