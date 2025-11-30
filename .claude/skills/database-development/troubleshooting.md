# Troubleshooting

This document covers common database development issues and their solutions.

## Migration Issues

### Migration Not Running

**Symptom:** Created migration SQL file but it doesn't execute

**Cause:** Missing entry in `_journal.json`

**Solution:**
```json
// Add to src/db/migrations/meta/_journal.json
{
  "idx": 25,  // Next sequential number
  "version": "7",
  "when": 1765000000000,  // Current timestamp
  "tag": "0025_your_migration_name",  // Must match filename without .sql
  "breakpoints": true
}
```

**Verification:**
```bash
# Check _journal.json entries
cat turbo/apps/web/src/db/migrations/meta/_journal.json | jq '.entries | length'

# Count SQL files
ls turbo/apps/web/src/db/migrations/*.sql | wc -l

# Numbers should match!
```

### CI Migration Fails But Works Locally

**Possible causes:**

1. **Different database state** - CI starts fresh, local has existing data
   ```bash
   # Test with fresh database
   docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -p 5433:5432 postgres:17-alpine
   DATABASE_URL="postgresql://postgres@localhost:5433/postgres" pnpm db:migrate
   ```

2. **Environment variable differences** - Check CI logs for DATABASE_URL format

3. **File not committed** - Verify migration file is in git
   ```bash
   git status turbo/apps/web/src/db/migrations/
   ```

### "relation does not exist" Error

**Symptom:**
```
Error: relation "table_name" does not exist
```

**Causes & Solutions:**

1. **Referencing old table name after rename**
   ```sql
   -- Wrong: referencing old name
   ALTER TABLE "old_name" ADD COLUMN ...

   -- Correct: use new name
   ALTER TABLE "new_name" ADD COLUMN ...
   ```

2. **Migration order incorrect**
   - Check `idx` values in `_journal.json`
   - Migrations run in order of `idx`

3. **Missing previous migration**
   - Ensure all migration files exist
   - Verify `_journal.json` has entries for all files

### Constraint Violation

**Symptom:**
```
Error: constraint "fk_name" already exists
```

**Solution:** Use `IF EXISTS` / `IF NOT EXISTS`:
```sql
ALTER TABLE "my_table" DROP CONSTRAINT IF EXISTS "fk_name";
ALTER TABLE "my_table" ADD CONSTRAINT "fk_name" ...;
```

## Schema Issues

### TypeScript Type Mismatch

**Symptom:** TypeScript errors after migration

**Cause:** Schema file doesn't match database state

**Solution:** Update schema file to match migration:
```typescript
// Before migration
export const myTable = pgTable("my_table", {
  id: uuid("id").defaultRandom().primaryKey(),
});

// After adding column via migration
export const myTable = pgTable("my_table", {
  id: uuid("id").defaultRandom().primaryKey(),
  newColumn: text("new_column"),  // Add this!
});
```

### Schema Not Exported

**Symptom:** Table not accessible via `globalThis.services.db`

**Solution:** Export in `db.ts`:
```typescript
// src/db/db.ts
import * as newSchema from "./schema/new-table";

export const schema = {
  ...existingSchemas,
  ...newSchema,  // Add this!
};
```

## Drizzle Kit Issues

### Generate Creates Wrong Migration

**Symptom:** `pnpm db:generate` creates unexpected changes

**Causes:**
1. Local schema differs from database
2. Previous migrations weren't applied locally

**Solution:**
```bash
# Reset local database and reapply all migrations
pnpm db:migrate

# Then generate
pnpm db:generate
```

### Studio Won't Connect

**Symptom:** `pnpm db:studio` fails

**Solution:** Check DATABASE_URL:
```bash
# Verify URL is set
echo $DATABASE_URL

# Try with explicit URL
DATABASE_URL="postgresql://..." pnpm db:studio
```

## CI-Specific Issues

### Neon Branch Creation Fails

**Check:**
1. `NEON_API_KEY` secret is set
2. `NEON_PROJECT_ID` variable is correct
3. Branch name doesn't have invalid characters

### Preview Migration Fails

**Debug steps:**
1. Check Neon console for branch status
2. Review migration logs in CI
3. Try resetting the branch manually

## Recovery Procedures

### Fixing a Broken Migration (Not Yet Merged)

1. Delete the SQL file
2. Remove entry from `_journal.json`
3. Fix schema file
4. Regenerate or rewrite migration

### Fixing a Broken Migration (Already in Main)

1. Create a NEW migration to fix the issue
2. Never modify existing migrations that are deployed
3. The new migration should correct the database state

### Rolling Back (Manual)

Drizzle doesn't support automatic rollback. To rollback:

1. Create a new migration that reverses changes
2. Example:
   ```sql
   -- 0026_rollback_previous.sql
   ALTER TABLE "my_table" DROP COLUMN "bad_column";
   ```

## Checklist When Things Go Wrong

- [ ] Is the migration file committed?
- [ ] Is `_journal.json` updated with correct `tag`?
- [ ] Does `idx` follow sequential order?
- [ ] Does schema file match new database state?
- [ ] Is schema exported in `db.ts`?
- [ ] Does local migration work on fresh database?
- [ ] Are all tests passing?
