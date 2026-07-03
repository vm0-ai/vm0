import { chatThreads } from "@vm0/db/schema/chat-thread";
import { workflowUserTriggerThreads } from "@vm0/db/schema/zero-workflow";
import { and, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

export async function loadWorkflowUserTriggerThreadId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  const [thread] = await db
    .select({ chatThreadId: workflowUserTriggerThreads.chatThreadId })
    .from(workflowUserTriggerThreads)
    .where(
      and(
        eq(workflowUserTriggerThreads.orgId, args.orgId),
        eq(workflowUserTriggerThreads.userId, args.userId),
        eq(workflowUserTriggerThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1);
  return thread?.chatThreadId ?? null;
}

async function createTriggerChatThread(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly title: string;
    readonly currentTime: Date;
  },
): Promise<string> {
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentId,
      title: args.title,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create workflow trigger chat thread");
  }
  await appendChatThreadEvent(db, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentComposeId: args.agentId,
    title: args.title,
    createdAt: thread.createdAt,
  });
  return thread.id;
}

export async function ensureWorkflowUserTriggerThread(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly currentTime: Date;
  },
): Promise<string> {
  const [existing] = await db
    .select({ chatThreadId: workflowUserTriggerThreads.chatThreadId })
    .from(workflowUserTriggerThreads)
    .where(
      and(
        eq(workflowUserTriggerThreads.orgId, args.orgId),
        eq(workflowUserTriggerThreads.userId, args.userId),
        eq(workflowUserTriggerThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1)
    .for("update");
  if (existing?.chatThreadId) {
    return existing.chatThreadId;
  }

  if (!existing) {
    const [inserted] = await db
      .insert(workflowUserTriggerThreads)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          workflowUserTriggerThreads.orgId,
          workflowUserTriggerThreads.userId,
          workflowUserTriggerThreads.workflowId,
        ],
      })
      .returning({ id: workflowUserTriggerThreads.id });
    if (!inserted) {
      const [conflicting] = await db
        .select({ chatThreadId: workflowUserTriggerThreads.chatThreadId })
        .from(workflowUserTriggerThreads)
        .where(
          and(
            eq(workflowUserTriggerThreads.orgId, args.orgId),
            eq(workflowUserTriggerThreads.userId, args.userId),
            eq(workflowUserTriggerThreads.workflowId, args.workflowId),
          ),
        )
        .limit(1)
        .for("update");
      if (conflicting?.chatThreadId) {
        return conflicting.chatThreadId;
      }
    }
  }

  const chatThreadId = await createTriggerChatThread(db, {
    userId: args.userId,
    orgId: args.orgId,
    agentId: args.agentId,
    title: args.workflowTitle,
    currentTime: args.currentTime,
  });

  const [updated] = await db
    .update(workflowUserTriggerThreads)
    .set({ chatThreadId, updatedAt: args.currentTime })
    .where(
      and(
        eq(workflowUserTriggerThreads.orgId, args.orgId),
        eq(workflowUserTriggerThreads.userId, args.userId),
        eq(workflowUserTriggerThreads.workflowId, args.workflowId),
      ),
    )
    .returning({ chatThreadId: workflowUserTriggerThreads.chatThreadId });
  if (!updated?.chatThreadId) {
    throw new Error("Failed to persist workflow trigger chat thread");
  }
  return updated.chatThreadId;
}
