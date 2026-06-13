import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  chatMessages,
  type ChatMessageUsagePayload,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0457_chat_usage_settlement_messages.sql",
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

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockChatUsageMigrationTest(tx: DbTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('chat_usage_message_migration_tests'))`,
  );
}

describe("migration 0457 chat usage settlement messages", () => {
  it("appends a new immutable message for stale usage payloads and stays idempotent", async () => {
    await runInRollbackTransaction(async (tx) => {
      await lockChatUsageMigrationTest(tx);

      const orgId = uniqueId("org");
      const userId = uniqueId("user");

      const [compose] = await tx
        .insert(agentComposes)
        .values({
          orgId,
          userId,
          name: uniqueId("compose"),
        })
        .returning({ id: agentComposes.id });

      const [session] = await tx
        .insert(agentSessions)
        .values({
          orgId,
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: agentSessions.id });

      const [thread] = await tx
        .insert(chatThreads)
        .values({
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: chatThreads.id });

      const [run] = await tx
        .insert(agentRuns)
        .values({
          orgId,
          userId,
          sessionId: session!.id,
          status: "completed",
          prompt: "run with later usage settlement",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: new Date("2026-01-01T00:02:00.000Z"),
        })
        .returning({ id: agentRuns.id });

      await tx.insert(zeroRuns).values({
        id: run!.id,
        triggerSource: "manual",
        chatThreadId: thread!.id,
      });

      const firstPayload = {
        version: 1,
        totalCredits: 10,
        settledAt: "2026-01-01T00:02:01.000Z",
        breakdown: [
          {
            kind: "model",
            credits: 10,
            providers: [{ provider: "vm0", credits: 10 }],
          },
        ],
      } satisfies ChatMessageUsagePayload;

      await tx.insert(chatMessages).values([
        {
          chatThreadId: thread!.id,
          runId: run!.id,
          role: "assistant",
          content: "done",
          createdAt: new Date("2026-01-01T00:01:00.000Z"),
        },
        {
          chatThreadId: thread!.id,
          runId: run!.id,
          role: "assistant",
          content: null,
          usagePayload: firstPayload,
          createdAt: new Date("2026-01-01T00:02:01.000Z"),
        },
      ]);

      await tx.insert(usageEvent).values([
        {
          runId: run!.id,
          orgId,
          userId,
          kind: "model",
          provider: "vm0",
          category: "tokens.output",
          quantity: 1,
          creditsCharged: 10,
          status: "processed",
          processedAt: new Date("2026-01-01T00:02:01.000Z"),
          idempotencyKey: randomUUID(),
        },
        {
          runId: run!.id,
          orgId,
          userId,
          kind: "image",
          provider: "gpt-image-1",
          category: "tokens.output.image",
          quantity: 1,
          creditsCharged: 50,
          status: "processed",
          processedAt: new Date("2026-01-01T00:02:10.000Z"),
          idempotencyKey: randomUUID(),
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const usageMessages = await tx
        .select({
          usagePayload: chatMessages.usagePayload,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.runId, run!.id),
            isNotNull(chatMessages.usagePayload),
          ),
        )
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

      expect(usageMessages).toHaveLength(2);
      expect(usageMessages[0]?.usagePayload).toStrictEqual(firstPayload);
      expect(usageMessages[1]?.createdAt.getTime()).toBeGreaterThan(
        usageMessages[0]!.createdAt.getTime(),
      );
      expect(usageMessages[1]?.usagePayload).toStrictEqual({
        version: 1,
        totalCredits: 60,
        settledAt: "2026-01-01T00:02:10.000Z",
        breakdown: [
          {
            kind: "image",
            credits: 50,
            providers: [{ provider: "gpt-image-1", credits: 50 }],
          },
          {
            kind: "model",
            credits: 10,
            providers: [{ provider: "vm0", credits: 10 }],
          },
        ],
      });
    });
  });
});
