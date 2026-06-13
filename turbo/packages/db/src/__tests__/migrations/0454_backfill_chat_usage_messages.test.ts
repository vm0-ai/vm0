import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
    "../../migrations/0454_backfill_chat_usage_messages.sql",
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

async function insertRun(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly status: string;
    readonly createdAt: Date;
    readonly completedAt: Date | null;
    readonly prompt: string;
  },
): Promise<string> {
  const [run] = await tx
    .insert(agentRuns)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      sessionId: args.sessionId,
      status: args.status,
      prompt: args.prompt,
      createdAt: args.createdAt,
      completedAt: args.completedAt,
    })
    .returning({ id: agentRuns.id });

  await tx.insert(zeroRuns).values({
    id: run!.id,
    triggerSource: "manual",
    chatThreadId: args.threadId,
  });

  return run!.id;
}

async function insertUsage(
  tx: DbTransaction,
  args: {
    readonly runId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly kind: string;
    readonly provider: string;
    readonly category: string;
    readonly creditsCharged: number | null;
    readonly status: "processed" | "pending";
    readonly processedAt: Date | null;
  },
): Promise<void> {
  await tx.insert(usageEvent).values({
    runId: args.runId,
    orgId: args.orgId,
    userId: args.userId,
    kind: args.kind,
    provider: args.provider,
    category: args.category,
    quantity: 1,
    creditsCharged: args.creditsCharged,
    status: args.status,
    processedAt: args.processedAt,
    createdAt: args.processedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    idempotencyKey: randomUUID(),
  });
}

async function lockChatUsageMigrationTest(tx: DbTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('chat_usage_message_migration_tests'))`,
  );
}

describe("migration 0454 backfill chat usage messages", () => {
  it("inserts missing usage messages after their run messages and stays idempotent", async () => {
    await runInRollbackTransaction(async (tx) => {
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

      const [orderedThread] = await tx
        .insert(chatThreads)
        .values({
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: chatThreads.id });

      const [pendingThread] = await tx
        .insert(chatThreads)
        .values({
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: chatThreads.id });

      const [existingThread] = await tx
        .insert(chatThreads)
        .values({
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: chatThreads.id });

      const targetRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: orderedThread!.id,
        status: "completed",
        prompt: "run with historical usage",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:02:00.000Z"),
      });
      const nextRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: orderedThread!.id,
        status: "running",
        prompt: "next user turn",
        createdAt: new Date("2026-01-01T00:10:00.000Z"),
        completedAt: null,
      });

      const terminalCreatedAt = new Date("2026-01-01T00:02:00.000Z");
      const nextUserCreatedAt = new Date("2026-01-01T00:10:00.000Z");
      await tx.insert(chatMessages).values([
        {
          chatThreadId: orderedThread!.id,
          runId: targetRunId,
          role: "user",
          content: "do expensive work",
          sequenceNumber: 0,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          chatThreadId: orderedThread!.id,
          runId: targetRunId,
          role: "assistant",
          content: "working result",
          sequenceNumber: 1,
          createdAt: new Date("2026-01-01T00:01:00.000Z"),
        },
        {
          chatThreadId: orderedThread!.id,
          runId: targetRunId,
          role: "assistant",
          content: null,
          runLifecycleEvent: "completed",
          sequenceNumber: 2,
          createdAt: terminalCreatedAt,
        },
        {
          chatThreadId: orderedThread!.id,
          runId: nextRunId,
          role: "user",
          content: "continue",
          sequenceNumber: 0,
          createdAt: nextUserCreatedAt,
        },
      ]);

      await insertUsage(tx, {
        runId: targetRunId,
        orgId,
        userId,
        kind: "model",
        provider: "moonshot",
        category: "tokens.input",
        creditsCharged: 234,
        status: "processed",
        processedAt: new Date("2026-01-01T00:02:05.000Z"),
      });
      await insertUsage(tx, {
        runId: targetRunId,
        orgId,
        userId,
        kind: "model",
        provider: "moonshot",
        category: "tokens.output",
        creditsCharged: 1000,
        status: "processed",
        processedAt: new Date("2026-01-01T00:02:10.000Z"),
      });
      await insertUsage(tx, {
        runId: targetRunId,
        orgId,
        userId,
        kind: "connector",
        provider: "github",
        category: "api_request",
        creditsCharged: 7,
        status: "processed",
        processedAt: new Date("2026-01-01T00:02:03.000Z"),
      });

      const pendingRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: pendingThread!.id,
        status: "completed",
        prompt: "run with pending usage",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        completedAt: new Date("2026-01-02T00:02:00.000Z"),
      });
      await insertUsage(tx, {
        runId: pendingRunId,
        orgId,
        userId,
        kind: "model",
        provider: "moonshot",
        category: "tokens.input",
        creditsCharged: 10,
        status: "processed",
        processedAt: new Date("2026-01-02T00:02:01.000Z"),
      });
      await insertUsage(tx, {
        runId: pendingRunId,
        orgId,
        userId,
        kind: "model",
        provider: "moonshot",
        category: "tokens.output",
        creditsCharged: null,
        status: "pending",
        processedAt: null,
      });

      const existingRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: existingThread!.id,
        status: "completed",
        prompt: "run with existing usage message",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        completedAt: new Date("2026-01-03T00:02:00.000Z"),
      });
      await insertUsage(tx, {
        runId: existingRunId,
        orgId,
        userId,
        kind: "connector",
        provider: "linear",
        category: "issue_read",
        creditsCharged: 5,
        status: "processed",
        processedAt: new Date("2026-01-03T00:02:01.000Z"),
      });
      const existingPayload = {
        version: 1,
        totalCredits: 5,
        settledAt: "2026-01-03T00:02:01.000Z",
        breakdown: [
          {
            kind: "connector",
            credits: 5,
            providers: [{ provider: "linear", credits: 5 }],
          },
        ],
      } satisfies ChatMessageUsagePayload;
      const [existingUsageMessage] = await tx
        .insert(chatMessages)
        .values({
          chatThreadId: existingThread!.id,
          runId: existingRunId,
          role: "assistant",
          content: null,
          usagePayload: existingPayload,
          createdAt: new Date("2026-01-03T00:02:02.000Z"),
        })
        .returning({ id: chatMessages.id });

      await lockChatUsageMigrationTest(tx);
      await tx.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_usage_run_id_unique"
        ON "chat_messages" USING btree ("run_id")
        WHERE "chat_messages"."usage_payload" IS NOT NULL
      `);
      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const orderedRows = await tx
        .select({
          runId: chatMessages.runId,
          role: chatMessages.role,
          content: chatMessages.content,
          runLifecycleEvent: chatMessages.runLifecycleEvent,
          usagePayload: chatMessages.usagePayload,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(eq(chatMessages.chatThreadId, orderedThread!.id))
        .orderBy(
          asc(chatMessages.createdAt),
          asc(chatMessages.sequenceNumber),
          asc(chatMessages.id),
        );

      expect(
        orderedRows.map((row) => {
          if (row.usagePayload !== null) {
            return "target:usage";
          }
          if (row.runLifecycleEvent !== null) {
            return `target:${row.runLifecycleEvent}`;
          }
          return row.runId === targetRunId
            ? `target:${row.role}:${row.content}`
            : `next:${row.role}:${row.content}`;
        }),
      ).toStrictEqual([
        "target:user:do expensive work",
        "target:assistant:working result",
        "target:completed",
        "target:usage",
        "next:user:continue",
      ]);

      const usageRow = orderedRows.find((row) => {
        return row.usagePayload !== null;
      });
      expect(usageRow?.createdAt.getTime()).toBeGreaterThan(
        terminalCreatedAt.getTime(),
      );
      expect(usageRow?.createdAt.getTime()).toBeLessThan(
        nextUserCreatedAt.getTime(),
      );
      expect(usageRow?.usagePayload).toStrictEqual({
        version: 1,
        totalCredits: 1241,
        settledAt: "2026-01-01T00:02:10.000Z",
        breakdown: [
          {
            kind: "connector",
            credits: 7,
            providers: [{ provider: "github", credits: 7 }],
          },
          {
            kind: "model",
            credits: 1234,
            providers: [{ provider: "moonshot", credits: 1234 }],
          },
        ],
      });

      const usageMessages = await tx
        .select({
          id: chatMessages.id,
          runId: chatMessages.runId,
        })
        .from(chatMessages)
        .where(
          and(
            inArray(chatMessages.runId, [
              targetRunId,
              pendingRunId,
              existingRunId,
            ]),
            isNotNull(chatMessages.usagePayload),
          ),
        )
        .orderBy(asc(chatMessages.runId), asc(chatMessages.id));

      const usageMessageIdsByRun = new Map<string, string[]>();
      for (const row of usageMessages) {
        if (row.runId === null) {
          continue;
        }
        const ids = usageMessageIdsByRun.get(row.runId) ?? [];
        ids.push(row.id);
        usageMessageIdsByRun.set(row.runId, ids);
      }

      expect(usageMessageIdsByRun.get(targetRunId)).toHaveLength(1);
      expect(usageMessageIdsByRun.get(pendingRunId)).toBeUndefined();
      expect(usageMessageIdsByRun.get(existingRunId)).toStrictEqual([
        existingUsageMessage!.id,
      ]);
    });
  });
});
