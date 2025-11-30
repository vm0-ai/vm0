# CI/CD Integration

This document explains how database migrations integrate with the CI/CD pipeline.

## Migration Points in CI

### 1. PR Tests (`turbo.yml` → `test` job)

**Purpose:** Verify migrations work and tests pass

```yaml
services:
  postgres:
    image: postgres:17-alpine

steps:
  - name: Run Database Migrations
    env:
      DATABASE_URL: postgresql://postgres@postgres:5432/postgres
    run: pnpm --filter web db:migrate
```

**What happens:**
- Fresh PostgreSQL container starts
- All migrations run from scratch
- Tests execute against migrated database

### 2. PR Preview (`turbo.yml` → `deploy-web` job)

**Purpose:** Create isolated preview environment with database

```yaml
- name: Create Neon Branch and Run Migrations
  uses: ./.github/actions/neon-branch
  with:
    action: "create"
```

**What happens:**
1. Creates Neon database branch from production
2. Runs pending migrations on branch
3. Deploys preview with branch database URL

**Neon Branch Action Flow:**
```
1. Check if branch exists
   ├── Exists → Reset to sync with main
   └── Not exists → Create new branch
2. Get database connection URL
3. Run migrations: pnpm -F web db:migrate
```

### 3. Production Release (`release-please.yml` → `migrate-production`)

**Purpose:** Apply migrations to production database

```yaml
migrate-production:
  needs: release-please
  if: ${{ needs.release-please.outputs.web_release_created == 'true' }}
  steps:
    - name: Run Production Migrations
      env:
        DATABASE_URL: ${{ steps.get-db-url.outputs.database-url }}
      run: cd turbo && pnpm -F web db:migrate
```

**What happens:**
- Only runs when web release is created
- Runs BEFORE production deployment
- Production deployment depends on migration success

## CI Failure Scenarios

### Missing _journal.json Entry

**Symptom:** Migration file exists but doesn't run

```
Running database migrations...
Migration complete
# (Your migration was skipped!)
```

**Fix:** Add entry to `_journal.json`

### Schema Mismatch

**Symptom:** Tests fail after migration

```
Error: column "new_column" does not exist
```

**Fix:** Ensure schema file matches migration SQL

### Migration SQL Error

**Symptom:** CI fails at migration step

```
Error: relation "old_table" does not exist
```

**Fix:** Check SQL syntax and object names

## Local Testing Before Push

Always test migrations locally:

```bash
# Start local postgres (if not using remote)
docker run -d -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:17-alpine

# Set DATABASE_URL
export DATABASE_URL="postgresql://postgres@localhost:5432/postgres"

# Run migrations
cd turbo/apps/web
pnpm db:migrate

# Run tests
pnpm test
```

## Debugging CI Failures

### Check Migration Output

Look for migration logs in CI:

```
Running database migrations...
Migration output:
[migration details here]
Migration complete
```

### Verify _journal.json

```bash
# Check last entry
cat turbo/apps/web/src/db/migrations/meta/_journal.json | jq '.entries[-1]'
```

### Verify Migration Files

```bash
# List all migrations
ls -la turbo/apps/web/src/db/migrations/*.sql

# Check file naming matches _journal.json tags
```

## Environment Variables

| Variable | Used In | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | All | PostgreSQL connection string |
| `NEON_API_KEY` | CI | Neon API authentication |
| `NEON_PROJECT_ID` | CI | Neon project identifier |

## Production Migration Safety

1. **Migrations run before deployment** - App won't deploy if migration fails
2. **Neon branches for preview** - Production data is never affected by PRs
3. **Branch reset on PR update** - Preview database syncs with production on each push
