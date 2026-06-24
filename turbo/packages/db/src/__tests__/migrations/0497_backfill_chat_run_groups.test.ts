import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0497_backfill_chat_run_groups.sql",
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

describe("migration 0497 backfill chat run groups", () => {
  it("backfills historical run groups from automation and workflow provenance", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");
      const automationRunGroupId = randomUUID();
      const workflowRunGroupId = randomUUID();
      const preservedRunGroupId = randomUUID();
      const preservedMessageRunGroupId = randomUUID();

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

      const [automation] = await tx
        .insert(automations)
        .values({
          orgId,
          userId,
          name: uniqueId("automation"),
          instruction: "run the historical automation",
          agentId: compose!.id,
          chatThreadId: thread!.id,
          interpreterKind: "default",
          runGroupId: automationRunGroupId,
        })
        .returning({ id: automations.id });

      const [automationTrigger] = await tx
        .insert(automationTriggers)
        .values({
          automationId: automation!.id,
          kind: "loop",
          intervalSeconds: 60,
        })
        .returning({ id: automationTriggers.id });

      const [workflow] = await tx
        .insert(zeroWorkflows)
        .values({
          orgId,
          agentId: compose!.id,
          name: uniqueId("workflow"),
          ownerUserId: userId,
          createdBy: userId,
        })
        .returning({ id: zeroWorkflows.id });

      const [workflowTrigger] = await tx
        .insert(zeroWorkflowTriggers)
        .values({
          orgId,
          workflowId: workflow!.id,
          ownerUserId: userId,
          kind: "event",
          eventType: "thread-idle",
          chatThreadId: thread!.id,
          runGroupId: workflowRunGroupId,
        })
        .returning({ id: zeroWorkflowTriggers.id });

      const directAutomationRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: thread!.id,
        prompt: "direct automation run",
        zeroRun: {
          triggerSource: "automation",
          automationId: automation!.id,
        },
      });
      const triggerOnlyRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: thread!.id,
        prompt: "trigger-only automation run",
        zeroRun: {
          triggerSource: "automation",
          triggerId: automationTrigger!.id,
        },
      });
      const workflowRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: thread!.id,
        prompt: "workflow trigger run",
        zeroRun: {
          triggerSource: "workflow",
          workflowTriggerId: workflowTrigger!.id,
        },
      });
      const preservedRunId = await insertRun(tx, {
        orgId,
        userId,
        sessionId: session!.id,
        threadId: thread!.id,
        prompt: "already grouped run",
        zeroRun: {
          triggerSource: "automation",
          automationId: automation!.id,
          runGroupId: preservedRunGroupId,
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

      const messageIds = {
        directAutomation: randomUUID(),
        triggerOnly: randomUUID(),
        workflow: randomUUID(),
        queuedAutomation: randomUUID(),
        preserved: randomUUID(),
        manual: randomUUID(),
      };

      await tx.insert(chatMessages).values([
        {
          id: messageIds.directAutomation,
          chatThreadId: thread!.id,
          runId: directAutomationRunId,
          automationId: automation!.id,
          role: "user",
          content: "direct automation message",
        },
        {
          id: messageIds.triggerOnly,
          chatThreadId: thread!.id,
          runId: triggerOnlyRunId,
          role: "assistant",
          content: "trigger-only assistant message",
        },
        {
          id: messageIds.workflow,
          chatThreadId: thread!.id,
          runId: workflowRunId,
          role: "assistant",
          content: "workflow assistant message",
        },
        {
          id: messageIds.queuedAutomation,
          chatThreadId: thread!.id,
          automationId: automation!.id,
          role: "user",
          content: "queued automation chip",
        },
        {
          id: messageIds.preserved,
          chatThreadId: thread!.id,
          runId: preservedRunId,
          role: "assistant",
          content: "already grouped message",
          runGroupId: preservedMessageRunGroupId,
        },
        {
          id: messageIds.manual,
          chatThreadId: thread!.id,
          runId: manualRunId,
          role: "assistant",
          content: "manual assistant message",
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const runRows = await tx
        .select({
          id: zeroRuns.id,
          runGroupId: zeroRuns.runGroupId,
        })
        .from(zeroRuns)
        .where(
          inArray(zeroRuns.id, [
            directAutomationRunId,
            triggerOnlyRunId,
            workflowRunId,
            preservedRunId,
            manualRunId,
          ]),
        );
      const runGroupByRunId = new Map(
        runRows.map((row) => {
          return [row.id, row.runGroupId];
        }),
      );

      expect(runGroupByRunId.get(directAutomationRunId)).toBe(
        automationRunGroupId,
      );
      expect(runGroupByRunId.get(triggerOnlyRunId)).toBe(automationRunGroupId);
      expect(runGroupByRunId.get(workflowRunId)).toBe(workflowRunGroupId);
      expect(runGroupByRunId.get(preservedRunId)).toBe(preservedRunGroupId);
      expect(runGroupByRunId.get(manualRunId)).toBeNull();

      const messageRows = await tx
        .select({
          id: chatMessages.id,
          runGroupId: chatMessages.runGroupId,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.id, Object.values(messageIds)));
      const runGroupByMessageId = new Map(
        messageRows.map((row) => {
          return [row.id, row.runGroupId];
        }),
      );

      expect(runGroupByMessageId.get(messageIds.directAutomation)).toBe(
        automationRunGroupId,
      );
      expect(runGroupByMessageId.get(messageIds.triggerOnly)).toBe(
        automationRunGroupId,
      );
      expect(runGroupByMessageId.get(messageIds.workflow)).toBe(
        workflowRunGroupId,
      );
      expect(runGroupByMessageId.get(messageIds.queuedAutomation)).toBe(
        automationRunGroupId,
      );
      expect(runGroupByMessageId.get(messageIds.preserved)).toBe(
        preservedMessageRunGroupId,
      );
      expect(runGroupByMessageId.get(messageIds.manual)).toBeNull();
    });
  });
});
