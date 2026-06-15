# 001: Backfill Clerk Organization IDs

## Scope Unification Migration Overview

PR #3592 unified personal/organization scope types with a local `scope_members`
table. The migration is phased:

| Phase                    | Status          | Description                                                 |
| ------------------------ | --------------- | ----------------------------------------------------------- |
| 1: Schema + Backfill     | Deployed        | `scope_members` table, `userId` columns, data backfill      |
| 2: Code Switch           | Deployed        | `resolveScope` rewrite, dual-write Clerk org for new scopes |
| **2.5: Batch Backfill**  | **This script** | Create Clerk orgs for existing scopes                       |
| 3: Constraints + Cleanup | Pending         | `NOT NULL`, drop old columns/tables                         |

## What This Script Does

Creates a Clerk Organization for every scope that has `clerkOrgId = NULL`, then
updates the scope row. After running, all scopes will have a `clerkOrgId`,
unblocking Phase 3's `NOT NULL` constraint.

## Prerequisites

- Node.js 18+
- `pnpm install` completed in the `turbo` directory
- Database migrations applied (`pnpm -F @vm0/db db:migrate`)
- Phase 1 + 2 deployed (PR #3592 merged)

## Environment Variables

| Variable           | Required              | Description                  |
| ------------------ | --------------------- | ---------------------------- |
| `DATABASE_URL`     | Yes                   | PostgreSQL connection string |
| `CLERK_SECRET_KEY` | Only with `--migrate` | Clerk API secret key         |

## Usage

Run from the `turbo/packages/db` directory:

```bash
# Dry run (default) — preview which scopes need backfilling
pnpm exec tsx scripts/migrations/001-backfill-clerk-orgs/backfill.ts

# Dry run for a single user
pnpm exec tsx scripts/migrations/001-backfill-clerk-orgs/backfill.ts --user-id=user_xxx

# Actual migration for a single user first
pnpm exec tsx scripts/migrations/001-backfill-clerk-orgs/backfill.ts --migrate --user-id=user_xxx

# Full migration
pnpm exec tsx scripts/migrations/001-backfill-clerk-orgs/backfill.ts --migrate
```

## Options

| Flag                      | Description                               |
| ------------------------- | ----------------------------------------- |
| `--migrate`               | Actually execute (default is dry-run)     |
| `--user-id=<clerkUserId>` | Only process the scope owned by this user |

## How It Works

1. Queries all scopes where `clerkOrgId IS NULL`, ordered by `createdAt`
2. For each scope, calls Clerk `createOrganization` with the scope's name and owner
3. Updates the scope row with the new `clerkOrgId`
4. Reports a summary with success/failure counts

### Idempotency

Safe to re-run. The script only selects scopes with `clerkOrgId IS NULL`, so
already-processed scopes are skipped automatically.

### Error Handling

- **Rate limit / server error** (429, 5xx): exponential backoff (up to 3 attempts)
- **Permanent error**: logs and skips the scope; does not block other scopes
- **Throttling**: ~100ms delay between Clerk API calls (~10 req/s)

## Verification

After running, confirm zero NULLs remain:

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM scopes WHERE clerk_org_id IS NULL;"
```

Expected output: `0`
