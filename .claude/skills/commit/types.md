# Commit Types - Detailed Reference

This document provides comprehensive details on all valid commit types in the vm0 project.

## Release-Triggering Types

### `feat:` - New Feature
**Triggers:** Minor version bump (e.g., 1.2.0 → 1.3.0)

Use when:
- Adding a completely new feature or capability
- Introducing new user-facing functionality
- Adding new API endpoints or methods
- Creating new components or modules

Examples:
- `feat: add user authentication system`
- `feat: add dark mode toggle`
- `feat(api): add payment processing endpoint`
- `feat: add export to csv functionality`

### `fix:` - Bug Fix
**Triggers:** Patch version bump (e.g., 1.2.0 → 1.2.1)

Use when:
- Fixing a bug or error in existing functionality
- Correcting unexpected behavior
- Resolving errors or exceptions
- Fixing performance issues

Examples:
- `fix: resolve database connection timeout`
- `fix: correct validation logic for email fields`
- `fix(auth): prevent token expiration edge case`
- `fix: handle null values in user profile`

**Special case:** You can use `fix:` for refactoring that improves code quality:
- `fix: refactor authentication logic for better maintainability`
- This is acceptable since refactoring often fixes technical debt

### `deps:` - Dependency Updates
**Triggers:** Patch version bump (e.g., 1.2.0 → 1.2.1)

Use when:
- Updating package dependencies
- Upgrading libraries or frameworks
- Security updates

Examples:
- `deps: update next.js to v14.2.0`
- `deps: bump typescript from 5.3 to 5.4`

## Non-Release Types

These types appear in the changelog but do NOT trigger a new release:

### `docs:` - Documentation
**Triggers:** No release

Use when:
- Updating README files
- Changing code comments
- Modifying documentation sites
- Updating API documentation

Examples:
- `docs: update installation instructions`
- `docs(api): add examples for webhook endpoints`
- `docs: fix typo in contributing guide`

### `style:` - Code Style
**Triggers:** No release

Use when:
- Formatting code (whitespace, semicolons)
- Linting fixes that don't change logic
- Code style improvements

Examples:
- `style: format code with prettier`
- `style: fix eslint warnings`
- `style: adjust indentation`

### `refactor:` - Code Refactoring
**Triggers:** No release

Use when:
- Restructuring code without changing behavior
- Improving code organization
- Extracting functions or modules
- Renaming variables for clarity

Examples:
- `refactor: extract validation logic to separate module`
- `refactor: simplify database query logic`
- `refactor(auth): reorganize authentication flow`

**Note:** If you want the refactor to trigger a release, use `fix: refactor ...` instead.

### `test:` - Test Changes
**Triggers:** No release

Use when:
- Adding new tests
- Modifying existing tests
- Fixing test failures
- Improving test coverage

Examples:
- `test: add unit tests for user service`
- `test: update e2e tests for checkout flow`
- `test: fix flaky integration test`

### `chore:` - Build/Tool Changes
**Triggers:** No release

Use when:
- Updating build scripts
- Modifying CI/CD configuration
- Changing development tools
- Updating package scripts

Examples:
- `chore: update build script for monorepo`
- `chore: configure prettier for typescript`
- `chore: add npm script for local development`

### `ci:` - CI Configuration
**Triggers:** No release

Use when:
- Modifying GitHub Actions workflows
- Updating CI/CD pipelines
- Changing release automation
- Adjusting build matrix

Examples:
- `ci: optimize release workflow dependencies`
- `ci: add caching for npm dependencies`
- `ci: update node version in workflow`

### `perf:` - Performance Improvements
**Triggers:** No release (unless breaking)

Use when:
- Optimizing performance
- Reducing bundle size
- Improving load times
- Optimizing algorithms

Examples:
- `perf: optimize image loading`
- `perf: reduce api response time`
- `perf: implement lazy loading for components`

### `build:` - Build System
**Triggers:** No release

Use when:
- Changing build configuration
- Modifying webpack/vite/turbo config
- Updating bundler settings

Examples:
- `build: update webpack config for production`
- `build: configure turborepo for better caching`

### `revert:` - Revert Previous Commit
**Triggers:** No release

Use when:
- Reverting a previous commit
- Rolling back changes

Examples:
- `revert: revert "feat: add dark mode"`
- `revert: roll back database migration`

## Breaking Changes

**Triggers:** Major version bump (e.g., 1.2.0 → 2.0.0)

Any type can be a breaking change by adding `!` after the type or including `BREAKING CHANGE:` in the footer:

```
feat!: change api response format to include metadata

BREAKING CHANGE: API responses now return {data, metadata} instead of raw data
```

Use breaking changes when:
- Changing public API contracts
- Removing features or endpoints
- Changing behavior in incompatible ways
- Requiring migration steps

## Scopes (Optional)

Scopes provide additional context about what area of the codebase was affected:

Examples:
- `feat(api): add user endpoint`
- `fix(auth): resolve token refresh issue`
- `docs(readme): update installation steps`
- `test(e2e): add checkout flow tests`

Common scopes in this project:
- `api` - API endpoints
- `auth` - Authentication
- `db` - Database
- `ui` - User interface
- `cli` - Command-line interface
