---
name: database-development
description: Database migrations and Drizzle ORM guidelines for the vm0 project
---

# Database Development

## Commands

```bash
cd turbo/apps/web

pnpm db:generate   # Generate migration from schema changes
pnpm db:migrate    # Run pending migrations
pnpm db:studio     # Open Drizzle Studio UI
```

## Critical: _journal.json

**Manual migrations MUST have an entry in `src/db/migrations/meta/_journal.json`.**

Without this entry, the migration will NOT run and CI will fail.

```json
{
  "idx": 25,                           // Next sequential number
  "version": "7",                      // Always "7"
  "when": 1765000000000,               // Timestamp (ms)
  "tag": "0025_my_migration",          // Must match filename without .sql
  "breakpoints": true
}
```

## Migration Workflows

### Auto-Generated (simple changes)

```bash
# 1. Edit schema in src/db/schema/
# 2. Generate (auto-updates _journal.json)
pnpm db:generate
# 3. Run locally
pnpm db:migrate
```

### Manual (renames, complex ALTER)

```bash
# 1. Create: src/db/migrations/XXXX_name.sql
# 2. Add entry to _journal.json  ← DON'T FORGET!
# 3. Update schema file to match
# 4. Run locally
pnpm db:migrate
```

## Data Migration Scripts (Clerk API)

When a data migration requires **external API calls** (e.g., reading from Clerk),
it cannot be done in a SQL migration. These scripts live in:

```
turbo/apps/web/scripts/migrations/NNN-description/
├── backfill.ts   # (or sync.ts) — the migration script
└── README.md     # Usage, prerequisites, verification steps
```

Pure data transforms that only touch the database should use regular SQL migrations instead.

### Convention

- **Numbered sequentially**: `001-`, `002-`, etc. — never reuse numbers
- **Permanent**: these scripts are historical records and MUST NOT be deleted,
  even after the migration is complete and the referenced tables/schemas no longer exist
- **Default dry-run**: use `parseArgs` with `--migrate` flag; default mode is dry-run
- **Self-contained**: each directory has its own README with usage instructions
- **Excluded from CI**: completed scripts that reference deleted schemas are excluded
  from `tsconfig.json` and `eslint.config.js` to avoid build errors

## Checklist

Before committing:

- [ ] Schema file updated in `src/db/schema/`
- [ ] Schema exported in `src/db/db.ts` (if new table)
- [ ] `_journal.json` updated (manual migrations)
- [ ] `pnpm db:migrate` works locally
- [ ] `pnpm test` passes
