import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Seeds malformed goal JSON left by legacy or manual database writes. The
 * current product API validates these shapes, so it cannot construct them.
 */
export async function seedInvalidLegacyGoalMessages(
  threadId: string,
): Promise<void> {
  const updated = await db().execute(sql`
    UPDATE chat_messages
    SET
      goal_event = '{"type":"state","status":"active","objectiveBrief":123}'::jsonb,
      goal_snapshot = '{"objectiveBrief":{"bad":true}}'::jsonb
    WHERE chat_thread_id = ${threadId}
      AND goal_event IS NOT NULL
  `);
  if (updated.rowCount !== 1) {
    throw new Error("Expected one current goal marker fixture");
  }

  const inserted = await db().execute(sql`
    INSERT INTO chat_messages (
      chat_thread_id,
      role,
      goal_event,
      goal_snapshot
    )
    VALUES (
      ${threadId},
      'assistant',
      '{"type":"state","status":"unknown","objectiveBrief":"bad"}'::jsonb,
      '{"objectiveBrief":{"bad":true}}'::jsonb
    )
  `);
  if (inserted.rowCount !== 1) {
    throw new Error("Expected one legacy goal marker fixture");
  }

  const insertedMissingSnapshotBrief = await db().execute(sql`
    INSERT INTO chat_messages (
      chat_thread_id,
      role,
      content,
      goal_snapshot
    )
    VALUES (
      ${threadId},
      'user',
      'legacy snapshot without objective brief',
      '{"bad":true}'::jsonb
    )
  `);
  if (insertedMissingSnapshotBrief.rowCount !== 1) {
    throw new Error("Expected one legacy goal snapshot fixture");
  }
}
