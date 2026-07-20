import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Seeds malformed goal JSON left by legacy or manual database writes. The
 * current product API validates these shapes, so it cannot construct them.
 */
export async function seedInvalidLegacyGoalMessages(
  threadId: string,
): Promise<void> {
  const { rowCount: insertedInvalidActiveMarkerCount } = await db().execute(sql`
    INSERT INTO chat_messages (
      chat_thread_id,
      role,
      goal_event,
      goal_snapshot
    )
    VALUES (
      ${threadId},
      'assistant',
      '{"type":"state","status":"active","objectiveBrief":123}'::jsonb,
      '{"objectiveBrief":{"bad":true}}'::jsonb
    )
  `);
  if (insertedInvalidActiveMarkerCount !== 1) {
    throw new Error("Expected one invalid active goal marker fixture");
  }

  const { rowCount: insertedCount } = await db().execute(sql`
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
  if (insertedCount !== 1) {
    throw new Error("Expected one legacy goal marker fixture");
  }

  const { rowCount: insertedMissingSnapshotBriefCount } = await db().execute(
    sql`
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
    `,
  );
  if (insertedMissingSnapshotBriefCount !== 1) {
    throw new Error("Expected one legacy goal snapshot fixture");
  }
}
