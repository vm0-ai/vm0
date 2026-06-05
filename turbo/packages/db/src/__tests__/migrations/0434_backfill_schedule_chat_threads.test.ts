import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0434_backfill_schedule_chat_threads.sql",
    import.meta.url,
  ),
  "utf8",
);

class RollbackMigrationTestTransaction extends Error {}

async function runInRollbackTransaction(
  callback: Parameters<typeof db.transaction>[0],
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await callback(tx);
      throw new RollbackMigrationTestTransaction();
    });
  } catch (error) {
    if (error instanceof RollbackMigrationTestTransaction) {
      return;
    }
    throw error;
  }
}

describe("migration 0434 backfill schedule chat threads", () => {
  it("creates one chat thread per legacy schedule without relinking existing schedules", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");
      const agentId = randomUUID();
      const existingThreadId = randomUUID();

      await tx.insert(agentComposes).values({
        id: agentId,
        userId,
        orgId,
        name: uniqueId("agent"),
      });

      await tx.insert(chatThreads).values({
        id: existingThreadId,
        userId,
        agentComposeId: agentId,
        title: "Already linked",
      });

      await tx.insert(zeroAgentSchedules).values([
        {
          id: randomUUID(),
          agentId,
          userId,
          orgId,
          name: "daily-report",
          triggerType: "cron",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          prompt: "Run daily report",
          description: "Daily report",
        },
        {
          id: randomUUID(),
          agentId,
          userId,
          orgId,
          name: "nightly",
          triggerType: "cron",
          cronExpression: "0 0 * * *",
          timezone: "UTC",
          prompt: "Run nightly task",
        },
        {
          id: randomUUID(),
          agentId,
          userId,
          orgId,
          name: "already-linked",
          triggerType: "cron",
          cronExpression: "0 12 * * *",
          timezone: "UTC",
          prompt: "Keep existing thread",
          chatThreadId: existingThreadId,
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const schedules = await tx
        .select({
          name: zeroAgentSchedules.name,
          chatThreadId: zeroAgentSchedules.chatThreadId,
        })
        .from(zeroAgentSchedules)
        .where(
          and(
            eq(zeroAgentSchedules.orgId, orgId),
            eq(zeroAgentSchedules.userId, userId),
          ),
        )
        .orderBy(asc(zeroAgentSchedules.name));

      expect(schedules).toHaveLength(3);
      expect(schedules[0]).toStrictEqual({
        name: "already-linked",
        chatThreadId: existingThreadId,
      });
      expect(schedules[1]?.chatThreadId).not.toBeNull();
      expect(schedules[2]?.chatThreadId).not.toBeNull();
      expect(schedules[1]?.chatThreadId).not.toBe(existingThreadId);
      expect(schedules[2]?.chatThreadId).not.toBe(existingThreadId);
      expect(schedules[1]?.chatThreadId).not.toBe(schedules[2]?.chatThreadId);

      const scheduleThreadIds = schedules.map((schedule) => {
        return schedule.chatThreadId ?? "";
      });
      const threads = await tx
        .select({
          id: chatThreads.id,
          userId: chatThreads.userId,
          agentComposeId: chatThreads.agentComposeId,
          title: chatThreads.title,
        })
        .from(chatThreads)
        .where(inArray(chatThreads.id, scheduleThreadIds))
        .orderBy(asc(chatThreads.title));

      expect(threads).toStrictEqual([
        {
          id: existingThreadId,
          userId,
          agentComposeId: agentId,
          title: "Already linked",
        },
        {
          id: schedules[1]?.chatThreadId,
          userId,
          agentComposeId: agentId,
          title: "Daily report",
        },
        {
          id: schedules[2]?.chatThreadId,
          userId,
          agentComposeId: agentId,
          title: "nightly",
        },
      ]);
    });
  });
});
