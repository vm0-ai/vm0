---
name: turbo-reset
description: Reset turbo environment (clean node_modules, reinstall, sync DB)
user-invocable: true
---

# Turbo Reset

Reset the turbo development environment to a clean state.

## Steps

1. Remove `node_modules` across the monorepo:
   ```bash
   cd turbo && rm -rf node_modules apps/*/node_modules packages/*/node_modules
   ```

2. Clear turbo cache:
   ```bash
   cd turbo && rm -rf .turbo apps/*/.turbo packages/*/.turbo
   ```

3. Reinstall dependencies:
   ```bash
   cd turbo && pnpm install
   ```

4. Sync database migrations:
   ```bash
   cd turbo/apps/web && pnpm db:migrate
   ```

Run all steps sequentially. Report success or failure after each step.
