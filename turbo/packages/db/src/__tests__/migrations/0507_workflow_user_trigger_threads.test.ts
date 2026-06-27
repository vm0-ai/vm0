import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, uniqueId } from "../test-db";

async function createShadowTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS zero_workflow_triggers_0507_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      owner_user_id text NOT NULL,
      workflow_id uuid NOT NULL,
      chat_thread_id uuid,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS workflow_user_trigger_threads_0507_shadow (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      workflow_id uuid NOT NULL,
      chat_thread_id uuid,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL,
      UNIQUE (org_id, user_id, workflow_id)
    )
  `);
}

async function truncateShadowTables(): Promise<void> {
  await db.execute(sql`
    TRUNCATE
      zero_workflow_triggers_0507_shadow,
      workflow_user_trigger_threads_0507_shadow
  `);
}

async function dropShadowTables(): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS
      zero_workflow_triggers_0507_shadow,
      workflow_user_trigger_threads_0507_shadow
  `);
}

async function insertLegacyTrigger(row: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly chatThreadId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO zero_workflow_triggers_0507_shadow (
      org_id,
      owner_user_id,
      workflow_id,
      chat_thread_id,
      created_at,
      updated_at
    )
    VALUES (
      ${row.orgId},
      ${row.userId},
      ${row.workflowId}::uuid,
      ${row.chatThreadId}::uuid,
      ${row.createdAt},
      ${row.updatedAt}
    )
  `);
}

async function runBackfillOnShadow(): Promise<void> {
  await db.execute(sql`
    WITH ranked_trigger_threads AS (
      SELECT
        zero_workflow_triggers_0507_shadow.org_id,
        zero_workflow_triggers_0507_shadow.owner_user_id AS user_id,
        zero_workflow_triggers_0507_shadow.workflow_id,
        zero_workflow_triggers_0507_shadow.chat_thread_id,
        zero_workflow_triggers_0507_shadow.created_at,
        zero_workflow_triggers_0507_shadow.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY
            zero_workflow_triggers_0507_shadow.org_id,
            zero_workflow_triggers_0507_shadow.owner_user_id,
            zero_workflow_triggers_0507_shadow.workflow_id
          ORDER BY
            zero_workflow_triggers_0507_shadow.updated_at DESC,
            zero_workflow_triggers_0507_shadow.created_at DESC,
            zero_workflow_triggers_0507_shadow.id DESC
        ) AS thread_rank
      FROM zero_workflow_triggers_0507_shadow
      WHERE zero_workflow_triggers_0507_shadow.chat_thread_id IS NOT NULL
    )
    INSERT INTO workflow_user_trigger_threads_0507_shadow (
      org_id,
      user_id,
      workflow_id,
      chat_thread_id,
      created_at,
      updated_at
    )
    SELECT
      org_id,
      user_id,
      workflow_id,
      chat_thread_id,
      created_at,
      updated_at
    FROM ranked_trigger_threads
    WHERE thread_rank = 1
    ON CONFLICT (org_id, user_id, workflow_id) DO UPDATE SET
      chat_thread_id = EXCLUDED.chat_thread_id,
      updated_at = EXCLUDED.updated_at
  `);
}

describe("migration 0507 workflow user trigger threads", () => {
  beforeEach(async () => {
    await createShadowTables();
    await truncateShadowTables();
  });

  afterAll(async () => {
    await dropShadowTables();
  });

  it("backfills one shared latest trigger thread per workflow user", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    const otherUserId = uniqueId("user");
    const workflowId = randomUUID();
    const olderThreadId = randomUUID();
    const newerThreadId = randomUUID();
    const otherUserThreadId = randomUUID();

    await insertLegacyTrigger({
      orgId,
      userId,
      workflowId,
      chatThreadId: olderThreadId,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    await insertLegacyTrigger({
      orgId,
      userId,
      workflowId,
      chatThreadId: newerThreadId,
      createdAt: new Date("2026-06-03T00:00:00.000Z"),
      updatedAt: new Date("2026-06-04T00:00:00.000Z"),
    });
    await insertLegacyTrigger({
      orgId,
      userId,
      workflowId,
      chatThreadId: null,
      createdAt: new Date("2026-06-05T00:00:00.000Z"),
      updatedAt: new Date("2026-06-06T00:00:00.000Z"),
    });
    await insertLegacyTrigger({
      orgId,
      userId: otherUserId,
      workflowId,
      chatThreadId: otherUserThreadId,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    await runBackfillOnShadow();

    const rows = await db.execute<{
      user_id: string;
      chat_thread_id: string;
    }>(sql`
      SELECT user_id, chat_thread_id::text
      FROM workflow_user_trigger_threads_0507_shadow
      ORDER BY user_id
    `);

    const threadsByUser = new Map(
      rows.rows.map((row) => {
        return [row.user_id, row.chat_thread_id];
      }),
    );
    expect(threadsByUser).toEqual(
      new Map([
        [userId, newerThreadId],
        [otherUserId, otherUserThreadId],
      ]),
    );
  });
});
