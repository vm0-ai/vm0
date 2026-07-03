---
name: database-development
description: Database migrations and Drizzle ORM guidelines for the vm0 project
---

# Database Development

## Commands

```bash
cd turbo/packages/db

pnpm db:generate   # Generate migration from schema changes
pnpm db:migrate    # Run pending migrations
pnpm db:studio     # Open Drizzle Studio UI
```

## Migration Workflows

### Auto-Generated (simple changes)

```bash
# 1. Edit schema in src/schema/
# 2. Generate migration (auto-updates _journal.json and snapshot)
pnpm db:generate
# 3. Run locally
pnpm db:migrate
```

### Custom SQL (renames, complex ALTER, data transforms)

Use `drizzle-kit generate --custom` to create an empty migration file managed by Drizzle.
This auto-updates `_journal.json` and snapshot — **never edit these manually**.

```bash
# 1. Generate empty migration file
pnpm drizzle-kit generate --custom --name=rename_foo_to_bar
# 2. Write SQL in the generated file
# 3. Update schema file to match
# 4. Run locally
pnpm db:migrate
```

## Data Migration Scripts (Clerk API)

When a data migration requires **external API calls** (e.g., reading from Clerk),
it cannot be done in a SQL migration. These scripts live in:

```
turbo/packages/db/scripts/migrations/NNN-description/
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

- [ ] Schema file updated in `src/schema/`
- [ ] Schema exported in `src/index.ts` (if new table)
- [ ] Custom migrations created via `drizzle-kit generate --custom` (not manually)
- [ ] `pnpm db:migrate` works locally
- [ ] `pnpm test` passes
