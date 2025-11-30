---
name: Database Development
description: Guidelines for database schema changes, migrations, and Drizzle ORM usage in the uspark project
---

# Database Development Skill

This skill provides comprehensive guidance on database development for the uspark project. It covers schema design, migration workflows, and common pitfalls to avoid.

## Tech Stack

- **ORM**: Drizzle ORM (^0.44.5)
- **Database**: PostgreSQL (Neon serverless)
- **Migration Tool**: drizzle-kit (^0.31.4)

## Quick Reference: Available Commands

```bash
cd turbo/apps/web

pnpm db:generate   # Generate migration from schema changes (drizzle-kit)
pnpm db:migrate    # Run pending migrations
pnpm db:seed       # Seed test data
pnpm db:studio     # Open Drizzle Studio UI
```

## Critical Rule: The _journal.json File

**THE MOST COMMON MISTAKE: Forgetting to update `_journal.json`**

When creating manual migrations, you MUST add an entry to `src/db/migrations/meta/_journal.json`. Without this entry, the migration will NOT run and CI will fail.

### _journal.json Entry Format

```json
{
  "idx": 24,                              // Sequential index
  "version": "7",                         // Always "7" for current drizzle
  "when": 1764900000000,                  // Timestamp in milliseconds
  "tag": "0024_storage_version_sha256",   // Must match SQL filename (without .sql)
  "breakpoints": true
}
```

**Checklist for manual migrations:**
- [ ] Created SQL file: `XXXX_descriptive_name.sql`
- [ ] Added entry to `_journal.json` with correct `idx` and `tag`
- [ ] Tag matches filename exactly (without .sql extension)

## Two Migration Workflows

### 1. Auto-Generated Migrations (Preferred for Simple Changes)

Use when: Adding new tables, columns, or simple schema changes.

```bash
# 1. Modify schema file in src/db/schema/
# 2. Generate migration
pnpm db:generate

# 3. Review generated SQL and _journal.json (both auto-updated)
# 4. Run migration locally
pnpm db:migrate
```

### 2. Manual Migrations (Required for Complex Changes)

Use when: Renaming tables/columns, data migrations, complex ALTER statements.

```bash
# 1. Create SQL file: src/db/migrations/XXXX_descriptive_name.sql
# 2. Add entry to _journal.json (THIS IS CRITICAL!)
# 3. Update schema file to match new state
# 4. Run migration locally
pnpm db:migrate
```

> For detailed workflows and examples, read `migration-workflow.md`

## Project Structure

```
turbo/apps/web/src/db/
├── schema/                    # Table definitions (Drizzle schema)
│   ├── user.ts
│   ├── agent-config.ts
│   ├── agent-run.ts
│   └── ...
├── migrations/               # SQL migration files
│   ├── 0000_real_sabretooth.sql
│   ├── 0001_huge_blue_shield.sql
│   └── meta/
│       └── _journal.json     # Migration registry (CRITICAL!)
├── db.ts                     # Schema exports
└── index.ts                  # Type exports
```

## CI/CD Integration

Migrations run automatically in CI at these points:

1. **PR Tests** (`turbo.yml` → `test` job): Against temporary PostgreSQL
2. **PR Preview** (`neon-branch` action): Creates Neon branch + runs migrations
3. **Production Release** (`release-please.yml` → `migrate-production`): Against production Neon

> For CI details, read `ci-integration.md`

## Quick Validation Checklist

Before committing database changes:

- [ ] Schema file updated in `src/db/schema/`
- [ ] Schema exported in `src/db/db.ts` (if new table)
- [ ] Migration SQL file created
- [ ] `_journal.json` updated (for manual migrations)
- [ ] Local migration runs successfully: `pnpm db:migrate`
- [ ] Tests pass: `pnpm test`

## When to Load Additional Context

- **Creating a new table?** → Read `schema-patterns.md`
- **Writing manual migrations?** → Read `migration-workflow.md`
- **Understanding CI pipeline?** → Read `ci-integration.md`
- **Debugging migration failures?** → Read `troubleshooting.md`
