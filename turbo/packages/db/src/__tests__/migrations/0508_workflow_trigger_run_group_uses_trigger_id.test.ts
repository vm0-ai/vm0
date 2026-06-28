import { randomUUID } from "node:crypto";

import { inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { db, uniqueId } from "../test-db";

/**
 * Integration test for the migration 0508 backfill body.
 *
 * The migration itself has already run against the test DB (the
 * `zero_workflow_triggers.run_group_id` column is gone), so re-running the DDL
 * is not possible. We seed rows that look like they pre-date the backfill — a
 * workflow-trigger run and its chat message still carrying a stale group id —
 * execute the backfill's UPDATE body verbatim, and assert that the trigger id
 * becomes the run group id for both the run and the message, while non-workflow
 * rows are left untouched.
 */

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
    readonly prompt: string;
    readonly zeroRun: Omit<typeof zeroRuns.$inferInsert, "id">;
  },
): Promise<string> {
  const [run] = await tx
    .insert(agentRuns)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      sessionId: args.sessionId,
      status: "completed",
      prompt: args.prompt,
    })
    .returning({ id: agentRuns.id });

  await tx.insert(zeroRuns).values({
    id: run!.id,
    chatThreadId: args.threadId,
    ...args.zeroRun,
  });

  return run!.id;
}

// The backfill body from `0508_workflow_trigger_run_group_uses_trigger_id.sql`
// (DDL omitted — the column is already dropped on the migrated test DB).
const backfillSql = sql.raw(`
UPDATE "zero_runs"
SET "run_group_id" = "zero_runs"."workflow_trigger_id"
WHERE "zero_runs"."workflow_trigger_id" IS NOT NULL;
UPDATE "chat_messages"
SET "run_group_id" = "zero_runs"."workflow_trigger_id"
FROM "zero_runs"
WHERE "chat_messages"."run_id" = "zero_runs"."id"
  AND "zero_runs"."workflow_trigger_id" IS NOT NULL;
`);

describe("migration 0508 backfill workflow trigger run groups", () => {
  it("repoints workflow-trigger runs and messages to the trigger id", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");
      const staleRunGroupId = randomUUID();
      const staleMessageGroupId = randomUUID();

      const [compose] = await tx
        .insert(agentComposes)
        .values({
          orgId,
          userId,
          name: uniqueId("compose"),
        })
        .returning({ id: agentComposes.id });

      await tx.insert(zeroAgents).values({
        id: compose!.id,
        orgId,
        owner: userId,
        name: uniqueId("agent"),
      });

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

      const [workflow] = await tx
        .insert(zeroWorkflows)
        .values({
          orgId,
          agentId: compose!.id,
          name: uniqueId("workflow"),
          ownerUserId: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning({ id: zeroWorkflows.id });

      const [workflowTrigger] = await tx
        .insert(zeroWorkflowTriggers)
        .values({
          orgId,
          workflowId: workflow!.id,
          ownerUserId: userId,
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { source: "migration-test" },
        })
        .returning({ id: zeroWorkflowTriggers.id });

      const workflowRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: thread!.id,
        prompt: "workflow trigger run",
        zeroRun: {
          triggerSource: "workflow",
          workflowTriggerId: workflowTrigger!.id,
          runGroupId: staleRunGroupId,
        },
      });
      const manualRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: thread!.id,
        prompt: "manual run",
        zeroRun: {
          triggerSource: "manual",
        },
      });

      const workflowMessageId = randomUUID();
      const manualMessageId = randomUUID();
      await tx.insert(chatMessages).values([
        {
          id: workflowMessageId,
          chatThreadId: thread!.id,
          runId: workflowRunId,
          role: "assistant",
          content: "workflow assistant message",
          runGroupId: staleMessageGroupId,
        },
        {
          id: manualMessageId,
          chatThreadId: thread!.id,
          runId: manualRunId,
          role: "assistant",
          content: "manual assistant message",
        },
      ]);

      await tx.execute(backfillSql);

      const runRows = await tx
        .select({
          id: zeroRuns.id,
          runGroupId: zeroRuns.runGroupId,
        })
        .from(zeroRuns)
        .where(inArray(zeroRuns.id, [workflowRunId, manualRunId]));
      const runGroupByRunId = new Map(
        runRows.map((row) => {
          return [row.id, row.runGroupId];
        }),
      );

      expect(runGroupByRunId.get(workflowRunId)).toBe(workflowTrigger!.id);
      expect(runGroupByRunId.get(manualRunId)).toBeNull();

      const messageRows = await tx
        .select({
          id: chatMessages.id,
          runGroupId: chatMessages.runGroupId,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.id, [workflowMessageId, manualMessageId]));
      const runGroupByMessageId = new Map(
        messageRows.map((row) => {
          return [row.id, row.runGroupId];
        }),
      );

      expect(runGroupByMessageId.get(workflowMessageId)).toBe(
        workflowTrigger!.id,
      );
      expect(runGroupByMessageId.get(manualMessageId)).toBeNull();
    });
  });
});
