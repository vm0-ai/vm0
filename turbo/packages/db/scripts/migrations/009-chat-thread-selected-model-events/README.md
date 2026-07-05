# 009: Backfill Chat Thread Selected Model Events

This script appends `model_selection_updated` events for historical chat
threads that already have `chat_threads.selected_model` set.

The Drizzle migration only adds the enum value and `selected_model` event
column. The data backfill is a separate script because the project migrator
runs pending migrations inside one transaction, and PostgreSQL cannot use a new
enum value for inserts until the enum migration is committed.

## Prerequisites

- `pnpm install` completed in the `turbo` directory
- Database migrations applied through `0541_chat_thread_selected_model_events`
- New API/platform code deployed so clients can consume
  `model_selection_updated`
- `DATABASE_URL` points to the target PostgreSQL database

## Usage

Run from `turbo/packages/db`:

```bash
# Dry run: report how many events would be inserted.
pnpm exec tsx scripts/migrations/009-chat-thread-selected-model-events/backfill.ts

# Apply the backfill.
pnpm exec tsx scripts/migrations/009-chat-thread-selected-model-events/backfill.ts --migrate
```

## Idempotency

The script only inserts an event when the thread's current `selected_model` is
non-null and there is no existing `model_selection_updated` event for the same
thread with the same `selected_model`. Re-running it skips rows already covered
by the backfill or by live writes from the deployed API.
