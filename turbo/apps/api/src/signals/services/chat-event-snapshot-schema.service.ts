import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { sql } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

type SnapshotSchemaDb = Pick<Db | ReadonlyDb, "select">;

/**
 * Cursor read that remains legal when a new API reaches a database from before
 * migration 0923. The Raw Event lookup is limited to the DB/API rollout window
 * (observed maximum: 102 minutes); remove it with #27174 once 0923 and its
 * rollback window are guaranteed everywhere.
 */
export const chatEventSnapshotLastEventId = sql`
  COALESCE(
    (to_jsonb(${chatEventSnapshots}) ->> 'last_event_id')::uuid,
    (
      -- Keep both sides qualified: Drizzle intentionally emits bare column
      -- names for column interpolations inside raw correlated subqueries.
      SELECT "snapshot_cursor_event"."id"
      FROM ${chatEvents} AS "snapshot_cursor_event"
      WHERE "snapshot_cursor_event"."chat_thread_id" =
        "chat_event_snapshots"."chat_thread_id"
        AND "snapshot_cursor_event"."seq_id" <=
          "chat_event_snapshots"."last_seq_id"
      ORDER BY "snapshot_cursor_event"."seq_id" DESC
      LIMIT 1
    )
  )
`.mapWith(nullableDriverValueDecoder(pgTextDecoder));

export async function chatEventSnapshotCursorSchemaAvailable(
  db: SnapshotSchemaDb,
): Promise<boolean> {
  // A new API can briefly serve before migration 0923. Snapshot mutations stay
  // on the old persisted contract for the observed DB/API window (102 minutes).
  // Remove this probe with #27174 after 0923 and rollback are guaranteed.
  const [state] = await db
    .select({
      available: sql`
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('chat_event_snapshots')
            AND attname = 'last_event_id'
            AND NOT attisdropped
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  if (!state) {
    throw new Error("Chat Event Snapshot cursor schema probe returned no row");
  }
  return state.available;
}
