import { chatThreads } from "@vm0/db/schema/chat-thread";
import { workflowUserAutomationThreads } from "@vm0/db/schema/zero-workflow";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import {
  chatThreadModelPinColumns,
  resolveRequiredDefaultChatThreadModelPin,
} from "./zero-chat-thread-model.service";
import {
  appendChatThreadEvent,
  type ChatThreadEventTransaction,
} from "./zero-chat-thread-event.service";

export async function loadWorkflowUserAutomationThreadId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  const [thread] = await db
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1);
  return thread?.chatThreadId ?? null;
}

export async function createAutomationChatThread(
  db: ChatThreadEventTransaction,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly title: string;
    readonly currentTime: Date;
  },
): Promise<string> {
  const pin = await resolveRequiredDefaultChatThreadModelPin(db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentId,
      title: args.title,
      ...chatThreadModelPinColumns(pin),
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create workflow automation chat thread");
  }
  await appendChatThreadEvent(db, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentComposeId: args.agentId,
    title: args.title,
    selectedModel: pin.selectedModel,
    createdAt: thread.createdAt,
  });
  return thread.id;
}

export async function ensureWorkflowUserAutomationThread(
  db: ChatThreadEventTransaction,
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
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1)
    .for("update");
  if (existing?.chatThreadId) {
    return existing.chatThreadId;
  }

  if (!existing) {
    const [inserted] = await db
      .insert(workflowUserAutomationThreads)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          workflowUserAutomationThreads.orgId,
          workflowUserAutomationThreads.userId,
          workflowUserAutomationThreads.workflowId,
        ],
      })
      .returning({ id: workflowUserAutomationThreads.id });
    if (!inserted) {
      const [conflicting] = await db
        .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
        .from(workflowUserAutomationThreads)
        .where(
          and(
            eq(workflowUserAutomationThreads.orgId, args.orgId),
            eq(workflowUserAutomationThreads.userId, args.userId),
            eq(workflowUserAutomationThreads.workflowId, args.workflowId),
          ),
        )
        .limit(1)
        .for("update");
      if (conflicting?.chatThreadId) {
        return conflicting.chatThreadId;
      }
    }
  }

  const chatThreadId = await createAutomationChatThread(db, {
    userId: args.userId,
    orgId: args.orgId,
    agentId: args.agentId,
    title: args.workflowTitle,
    currentTime: args.currentTime,
  });

  const [updated] = await db
    .update(workflowUserAutomationThreads)
    .set({ chatThreadId, updatedAt: args.currentTime })
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .returning({ chatThreadId: workflowUserAutomationThreads.chatThreadId });
  if (!updated?.chatThreadId) {
    throw new Error("Failed to persist workflow automation chat thread");
  }
  return updated.chatThreadId;
}
