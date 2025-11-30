# Migration Workflow

This document provides detailed guidance on creating and managing database migrations.

## Auto-Generated vs Manual Migrations

### When to Use Auto-Generated

- Adding a new table
- Adding a new column (non-breaking)
- Adding indexes
- Changing column defaults

```bash
# 1. Edit schema file
# 2. Generate migration
cd turbo/apps/web && pnpm db:generate
# 3. Review generated files in src/db/migrations/
# 4. Run migration
pnpm db:migrate
```

### When to Use Manual Migrations

- Renaming tables or columns
- Data migrations (transforming existing data)
- Complex multi-step operations
- Dropping constraints before altering columns

## Manual Migration Step-by-Step

### Step 1: Create the SQL File

Create a new file: `src/db/migrations/XXXX_descriptive_name.sql`

File naming convention:
- `XXXX` = 4-digit sequential number (e.g., 0025)
- Use snake_case for description
- Be descriptive: `0025_add_status_to_agent_runs.sql`

### Step 2: Update _journal.json (CRITICAL!)

Add entry to `src/db/migrations/meta/_journal.json`:

```json
{
  "idx": 25,
  "version": "7",
  "when": 1765000000000,
  "tag": "0025_add_status_to_agent_runs",
  "breakpoints": true
}
```

**Important:**
- `idx` must be sequential (check last entry)
- `tag` must match filename WITHOUT `.sql` extension
- `when` should be current timestamp in milliseconds

### Step 3: Update Schema File

Update the corresponding schema file to match the new database state:

```typescript
// src/db/schema/agent-run.ts
export const agentRuns = pgTable("agent_runs", {
  // ... existing columns
  status: varchar("status", { length: 20 }).notNull(), // Add new column
});
```

### Step 4: Test Locally

```bash
cd turbo/apps/web
pnpm db:migrate
pnpm test
```

## SQL Best Practices

### Use Statement Breakpoints

For multi-statement migrations, use `--> statement-breakpoint`:

```sql
ALTER TABLE "volumes" RENAME TO "storages";
--> statement-breakpoint
ALTER TABLE "storage_versions" RENAME COLUMN "volume_id" TO "storage_id";
--> statement-breakpoint
ALTER INDEX "idx_volumes_user_name" RENAME TO "idx_storages_user_name";
```

### Handle Constraints Properly

When altering columns with constraints:

```sql
-- Step 1: Drop constraint
ALTER TABLE "storages" DROP CONSTRAINT IF EXISTS "storages_head_version_id_fk";

-- Step 2: Alter column
ALTER TABLE "storages" ALTER COLUMN "head_version_id" TYPE varchar(64);

-- Step 3: Re-add constraint
ALTER TABLE "storages" ADD CONSTRAINT "storages_head_version_id_fk"
  FOREIGN KEY ("head_version_id") REFERENCES "storage_versions"("id");
```

### Use IF EXISTS for Safety

```sql
ALTER TABLE "my_table" DROP CONSTRAINT IF EXISTS "my_constraint";
DROP INDEX IF EXISTS "my_index";
```

## Common Patterns

### Adding a Nullable Column

```sql
ALTER TABLE "agent_runs" ADD COLUMN "error" text;
```

### Adding a NOT NULL Column

```sql
-- Add with default first
ALTER TABLE "agent_runs" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;
```

### Renaming a Column

```sql
ALTER TABLE "agent_runs" RENAME COLUMN "old_name" TO "new_name";
```

### Adding an Index

```sql
CREATE INDEX "idx_agent_runs_status" ON "agent_runs" ("status");
```

### Creating a Unique Index

```sql
CREATE UNIQUE INDEX "idx_storages_user_name" ON "storages" ("user_id", "name");
```

## Rollback Strategy

Drizzle does not support automatic rollbacks. For each migration, consider:

1. **Can it be reversed?** Keep the reverse SQL handy
2. **Is it destructive?** Test thoroughly before production
3. **Data loss risk?** Always backup before dropping columns/tables

## Migration Checklist

Before committing:

- [ ] SQL file created with correct naming
- [ ] `_journal.json` entry added with matching tag
- [ ] Schema file updated to match new state
- [ ] Local migration runs without errors
- [ ] Tests pass
- [ ] No breaking changes to existing queries
