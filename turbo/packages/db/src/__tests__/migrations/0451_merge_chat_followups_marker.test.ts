import { readFileSync } from "node:fs";

import { asc, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0451_merge_chat_followups_marker.sql",
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

describe("migration 0451 merge chat followups marker", () => {
  it("backfills legacy error placeholders without mutating queue revoke controls", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");
      const runError = "runner failed after queue drain";

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

      const [run] = await tx
        .insert(agentRuns)
        .values({
          orgId,
          userId,
          sessionId: session!.id,
          status: "failed",
          prompt: "queued run that eventually failed",
          error: runError,
        })
        .returning({ id: agentRuns.id });

      const [thread] = await tx
        .insert(chatThreads)
        .values({
          userId,
          agentComposeId: compose!.id,
        })
        .returning({ id: chatThreads.id });

      const [legacyPlaceholder] = await tx
        .insert(chatMessages)
        .values({
          chatThreadId: thread!.id,
          runId: run!.id,
          role: "assistant",
          content: null,
        })
        .returning({ id: chatMessages.id });

      const [queueMarker] = await tx
        .insert(chatMessages)
        .values({
          chatThreadId: thread!.id,
          runId: run!.id,
          role: "assistant",
          content: "Waiting in queue...",
          runEventId: "queue:queued",
        })
        .returning({ id: chatMessages.id });

      const [queueRevoker] = await tx
        .insert(chatMessages)
        .values({
          chatThreadId: thread!.id,
          runId: run!.id,
          role: "assistant",
          content: null,
          revokesMessageId: queueMarker!.id,
          runEventId: "queue:dequeued",
        })
        .returning({ id: chatMessages.id });

      await tx.execute(sql.raw(migrationSql));

      const rows = await tx
        .select({
          id: chatMessages.id,
          content: chatMessages.content,
          error: chatMessages.error,
          revokesMessageId: chatMessages.revokesMessageId,
          runEventId: chatMessages.runEventId,
        })
        .from(chatMessages)
        .where(
          inArray(chatMessages.id, [legacyPlaceholder!.id, queueRevoker!.id]),
        )
        .orderBy(asc(chatMessages.id));

      const byId = new Map(
        rows.map((row) => {
          return [row.id, row];
        }),
      );

      expect(byId.get(legacyPlaceholder!.id)).toStrictEqual({
        id: legacyPlaceholder!.id,
        content: runError,
        error: runError,
        revokesMessageId: null,
        runEventId: null,
      });
      expect(byId.get(queueRevoker!.id)).toStrictEqual({
        id: queueRevoker!.id,
        content: null,
        error: null,
        revokesMessageId: queueMarker!.id,
        runEventId: "queue:dequeued",
      });
    });
  });
});
