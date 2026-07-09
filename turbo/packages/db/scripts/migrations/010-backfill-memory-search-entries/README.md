# 010: Backfill Memory Search Entries

This script builds pgvector search entries for historical structured memory
rows. Live writes from the deployed API keep `memory_search_entries` updated
after this PR; this backfill covers memories that already existed before the
semantic recall index was introduced.

## Prerequisites

- Database migrations applied through `0560_luxuriant_titania`
- `DATABASE_URL` points to the target PostgreSQL database
- `OPENAI_API_KEY` is set
- Optional: `ZERO_MEMORY_EMBEDDING_MODEL` to override the default
  `text-embedding-3-small`

## Usage

Run from `turbo/packages/db`:

```bash
# Dry run: report candidate count.
pnpm exec tsx scripts/migrations/010-backfill-memory-search-entries/backfill.ts

# Apply the backfill.
pnpm exec tsx scripts/migrations/010-backfill-memory-search-entries/backfill.ts --migrate
```

## Idempotency

The script upserts one `memory_text` search entry per active memory and
embedding model. Re-running it refreshes changed rows and skips unchanged rows
through the `content_hash`.
