import type { SharedMessage } from "@vm0/api-contracts/contracts/shared-threads";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { artifacts } from "@vm0/db/schema/artifact";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { sharedThreads } from "@vm0/db/schema/shared-thread";
import { and, asc, eq, inArray } from "drizzle-orm";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { publishArtifactCatalogChanged } from "./artifact-realtime.service";
import { visibleChatEventCondition } from "./zero-chat-event-shared.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { generateSharedThreadTitle } from "./zero-chat-title.service";
import { projectUserMessageForPublicShare } from "./zero-chat-user-message.service";

const SHARED_THREAD_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

interface CreateSharedThreadArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly eventIds: readonly string[];
}

type CreateSharedThreadResult =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "no-shareable-messages" }
  | { readonly kind: "too-large" };

function localIndex(
  sourceId: string | null,
  indices: Map<string, number>,
): number | undefined {
  if (sourceId === null) {
    return undefined;
  }
  const existing = indices.get(sourceId);
  if (existing !== undefined) {
    return existing;
  }
  const next = indices.size;
  indices.set(sourceId, next);
  return next;
}

export const createSharedThread$ = command(
  async (
    { set },
    args: CreateSharedThreadArgs,
    signal: AbortSignal,
  ): Promise<CreateSharedThreadResult> => {
    const database = set(writeDb$);
    const [thread] = await database
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(
        agentComposes,
        eq(agentComposes.id, chatThreads.agentComposeId),
      )
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
          eq(agentComposes.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return { kind: "thread-not-found" };
    }

    const selectedEventIds = [...new Set(args.eventIds)];
    const rows = await database
      .select({
        eventType: chatEvents.eventType,
        content: chatEvents.content,
        userMessage: chatEvents.userMessage,
        runId: chatEvents.runId,
        runGroupId: chatEvents.runGroupId,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          inArray(chatEvents.id, selectedEventIds),
          chatEventTypeIn([
            "input.prompt",
            "input.automation",
            "output.message",
          ]),
          visibleChatEventCondition(database),
        ),
      )
      .orderBy(asc(chatEvents.seqId));
    signal.throwIfAborted();

    const runIndices = new Map<string, number>();
    const runGroupIndices = new Map<string, number>();
    const messages: SharedMessage[] = [];
    for (const row of rows) {
      const content =
        row.eventType === "output.message"
          ? row.content
          : row.userMessage
            ? projectUserMessageForPublicShare(row.userMessage)
            : row.content;
      if (content === null || content.length === 0) {
        continue;
      }
      const runIndex = localIndex(row.runId, runIndices);
      const runGroupIndex = localIndex(row.runGroupId, runGroupIndices);
      messages.push({
        messageIndex: messages.length,
        role: row.eventType === "output.message" ? "assistant" : "user",
        content,
        ...(runIndex === undefined ? {} : { runIndex }),
        ...(runGroupIndex === undefined ? {} : { runGroupIndex }),
      });
    }

    if (messages.length === 0) {
      return { kind: "no-shareable-messages" };
    }
    const serializedMessages = JSON.stringify(messages);
    if (
      new TextEncoder().encode(serializedMessages).byteLength >
      SHARED_THREAD_MAX_SERIALIZED_BYTES
    ) {
      return { kind: "too-large" };
    }

    const title = await generateSharedThreadTitle(messages);
    signal.throwIfAborted();
    const createdAt = nowDate();
    const id = await database.transaction(async (transaction) => {
      const [sharedThread] = await transaction
        .insert(sharedThreads)
        .values({
          userId: args.userId,
          sourceChatThreadId: args.threadId,
          title,
          messages,
          createdAt,
        })
        .returning({ id: sharedThreads.id });
      if (!sharedThread) {
        throw new Error("Shared thread insert did not return a row");
      }
      await transaction.insert(artifacts).values({
        orgId: args.orgId,
        authorUserId: args.userId,
        kind: "shared-thread",
        entityId: sharedThread.id,
        logicalKey: `shared-thread:${sharedThread.id}`,
        projectionFileId: null,
        projectionCreatedAt: createdAt,
        title,
        thumbnail: null,
        createdAt,
        updatedAt: createdAt,
      });
      return sharedThread.id;
    });
    signal.throwIfAborted();

    await Promise.all([
      publishArtifactCatalogChanged([args.userId]),
      publishUserSignal(
        [args.userId],
        `chatThreadArtifactsChanged:${args.threadId}`,
      ),
    ]);
    signal.throwIfAborted();
    return { kind: "created", id };
  },
);

export const readSharedThread$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: sharedThreads.id,
        title: sharedThreads.title,
        messages: sharedThreads.messages,
      })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);

export const readSharedThreadMeta$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({ title: sharedThreads.title })
      .from(sharedThreads)
      .where(eq(sharedThreads.id, id))
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);
