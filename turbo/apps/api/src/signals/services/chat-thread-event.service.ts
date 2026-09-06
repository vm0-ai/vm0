import { and, asc, eq, exists, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  ChatThreadEvent,
  ChatThreadServiceTier,
  ChatThreadSnapshotProjection,
  CodexServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { agents } from "@okouai/db/schema/agent";
import {
  chatThreadEventSequences,
  chatThreadEvents,
  type ChatThreadEventKind,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";

import type { ReadonlyDb } from "../external/db";
import type { Tx } from "../../lib/db-types";

// The sequence row lock must remain held until its event becomes visible.
// Requiring a transaction prevents callers from splitting those two commits.
export type ChatThreadEventTransaction = Tx;
const CHAT_THREAD_EVENTS_PAGE_SIZE = 1000;
const cursorChatThreadEvent = alias(
  chatThreadEvents,
  "cursor_chat_thread_event",
);
const pageChatThreadEvent = alias(chatThreadEvents, "page_chat_thread_event");

async function reserveChatThreadEventSeqId(
  db: ChatThreadEventTransaction,
  userId: string,
  orgId: string,
): Promise<number> {
  const [sequence] = await db
    .insert(chatThreadEventSequences)
    .values({
      userId,
      orgId,
      lastSeqId: 1,
    })
    .onConflictDoUpdate({
      target: [chatThreadEventSequences.userId, chatThreadEventSequences.orgId],
      set: {
        lastSeqId: sql`${chatThreadEventSequences.lastSeqId} + 1`,
      },
    })
    .returning({ seqId: chatThreadEventSequences.lastSeqId });
  if (!sequence) {
    throw new Error("Unable to reserve chat thread event seq_id");
  }
  return sequence.seqId;
}

export async function appendChatThreadEvent(
  db: ChatThreadEventTransaction,
  args: {
    readonly kind: ChatThreadEventKind;
    readonly userId: string;
    readonly orgId?: string | null;
    readonly chatThreadId: string;
    readonly agentId: string;
    readonly eventId?: string;
    readonly title?: string | null;
    readonly pinOrder?: string | null;
    readonly selectedModel?: string | null;
    readonly serviceTier?: ChatThreadServiceTier | null;
    readonly computerUseHostId?: string | null;
    readonly cloudBrowserEnabled?: boolean;
    readonly selectedVideoModel?: string | null;
    readonly selectedImageModel?: ImageModelId | null;
    readonly createdAt?: Date;
  },
): Promise<void> {
  let orgId = args.orgId ?? undefined;
  if (orgId === undefined) {
    const [compose] = await db
      .select({ orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, args.agentId))
      .limit(1);
    orgId = compose?.orgId;
  }

  if (orgId === undefined) {
    throw new Error("Unable to resolve org for chat thread event");
  }

  const seqId = await reserveChatThreadEventSeqId(db, args.userId, orgId);

  await db
    .insert(chatThreadEvents)
    .values({
      ...(args.eventId !== undefined ? { id: args.eventId } : {}),
      userId: args.userId,
      orgId,
      seqId,
      chatThreadId: args.chatThreadId,
      kind: args.kind,
      agentId: args.agentId,
      title: args.title ?? null,
      pinOrder: args.pinOrder ?? null,
      selectedModel: args.selectedModel ?? null,
      serviceTier: args.serviceTier ?? null,
      computerUseHostId: args.computerUseHostId ?? null,
      cloudBrowserEnabled: args.cloudBrowserEnabled ?? false,
      selectedVideoModel: args.selectedVideoModel ?? null,
      selectedImageModel: args.selectedImageModel ?? null,
      ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
    })
    .onConflictDoNothing({ target: chatThreadEvents.id });
}

export async function getChatThreadSnapshot(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<{
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}> {
  const [snapshot] = await db
    .select({
      latestEventId: chatThreadSnapshots.latestEventId,
      latestSeqId: chatThreadSnapshots.latestEventSeqId,
      chatThreads: chatThreadSnapshots.chatThreads,
    })
    .from(chatThreadSnapshots)
    .where(
      and(
        eq(chatThreadSnapshots.userId, args.userId),
        eq(chatThreadSnapshots.orgId, args.orgId),
      ),
    )
    .limit(1);

  return {
    chatThreads:
      snapshot?.chatThreads.map((thread) => {
        return {
          ...thread,
          selectedModel: thread.selectedModel ?? null,
          serviceTier: thread.serviceTier ?? null,
          computerUseHostId: thread.computerUseHostId ?? null,
          cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
          // Rollout fallback: snapshot rows compacted before this migration
          // carry no selectedVideoModel key. Bounded by the compaction
          // staleness cutoff (CHAT_THREAD_SNAPSHOT_STALE_MS, 24h) plus batch
          // drain, not by a deploy window. Remove once every snapshot row has
          // been recompacted. Follow-up:
          // https://github.com/vm0-ai/vm0/issues/26765
          selectedVideoModel: thread.selectedVideoModel ?? null,
          // Snapshot rows compacted before image-model persistence have no key.
          // Keep hydration compatible until those rows and older browser caches
          // have been replaced. Follow-up:
          // https://github.com/vm0-ai/vm0/issues/27688
          selectedImageModel: thread.selectedImageModel ?? null,
        };
      }) ?? [],
    latestEventId: snapshot?.latestEventId ?? null,
    latestSeqId: snapshot?.latestSeqId ?? null,
  };
}

type ChatThreadEventRow = {
  readonly id: string;
  readonly seqId: number;
  readonly kind: ChatThreadEventKind;
  readonly chatThreadId: string;
  readonly agentId: string | null;
  readonly title: string | null;
  readonly pinOrder: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
  readonly createdAt: Date;
};

export function chatThreadServiceTierFromCodex(
  codexServiceTier: CodexServiceTier | null,
): ChatThreadServiceTier | null {
  return codexServiceTier === "fast" ? "priority" : null;
}

function hasCanonicalAgentReference(
  row: ChatThreadEventRow,
): row is ChatThreadEventRow & { readonly agentId: string } {
  return row.agentId !== null;
}

function toApiChatThreadEvent(
  row: ChatThreadEventRow & { readonly agentId: string },
): ChatThreadEvent {
  return {
    id: row.id,
    seqId: row.seqId,
    kind: row.kind,
    chatThreadId: row.chatThreadId,
    agentId: row.agentId,
    title: row.title,
    pinOrder: row.pinOrder,
    selectedModel: row.selectedModel,
    serviceTier: row.serviceTier,
    computerUseHostId: row.computerUseHostId,
    cloudBrowserEnabled: row.cloudBrowserEnabled,
    selectedVideoModel: row.selectedVideoModel,
    selectedImageModel: row.selectedImageModel,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getChatThreadEventsSince(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly sinceSeqId?: number;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly events: readonly ChatThreadEvent[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" }
> {
  let rows: readonly ChatThreadEventRow[];
  const cursorPredicate =
    args.sinceSeqId === undefined
      ? undefined
      : eq(cursorChatThreadEvent.seqId, args.sinceSeqId);
  if (cursorPredicate !== undefined) {
    // Keep a valid cursor row when its page is empty.
    const cursorRows = await db
      .select({
        event: {
          id: pageChatThreadEvent.id,
          seqId: pageChatThreadEvent.seqId,
          kind: pageChatThreadEvent.kind,
          chatThreadId: pageChatThreadEvent.chatThreadId,
          agentId: pageChatThreadEvent.agentId,
          title: pageChatThreadEvent.title,
          pinOrder: pageChatThreadEvent.pinOrder,
          selectedModel: pageChatThreadEvent.selectedModel,
          serviceTier: pageChatThreadEvent.serviceTier,
          computerUseHostId: pageChatThreadEvent.computerUseHostId,
          cloudBrowserEnabled: pageChatThreadEvent.cloudBrowserEnabled,
          selectedVideoModel: pageChatThreadEvent.selectedVideoModel,
          selectedImageModel: pageChatThreadEvent.selectedImageModel,
          createdAt: pageChatThreadEvent.createdAt,
        },
      })
      .from(cursorChatThreadEvent)
      .leftJoin(
        pageChatThreadEvent,
        and(
          eq(pageChatThreadEvent.userId, args.userId),
          eq(pageChatThreadEvent.orgId, args.orgId),
          gt(pageChatThreadEvent.seqId, cursorChatThreadEvent.seqId),
          exists(
            db
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.id, pageChatThreadEvent.agentId)),
          ),
        ),
      )
      .where(
        and(
          eq(cursorChatThreadEvent.userId, args.userId),
          eq(cursorChatThreadEvent.orgId, args.orgId),
          cursorPredicate,
        ),
      )
      .orderBy(asc(pageChatThreadEvent.seqId))
      .limit(CHAT_THREAD_EVENTS_PAGE_SIZE + 1);
    if (cursorRows.length === 0) {
      return { kind: "expired" };
    }
    rows = cursorRows.flatMap((row) => {
      return row.event ? [row.event] : [];
    });
  } else {
    rows = await db
      .select({
        id: chatThreadEvents.id,
        seqId: chatThreadEvents.seqId,
        kind: chatThreadEvents.kind,
        chatThreadId: chatThreadEvents.chatThreadId,
        agentId: chatThreadEvents.agentId,
        title: chatThreadEvents.title,
        pinOrder: chatThreadEvents.pinOrder,
        selectedModel: chatThreadEvents.selectedModel,
        serviceTier: chatThreadEvents.serviceTier,
        computerUseHostId: chatThreadEvents.computerUseHostId,
        cloudBrowserEnabled: chatThreadEvents.cloudBrowserEnabled,
        selectedVideoModel: chatThreadEvents.selectedVideoModel,
        selectedImageModel: chatThreadEvents.selectedImageModel,
        createdAt: chatThreadEvents.createdAt,
      })
      .from(chatThreadEvents)
      .where(
        and(
          eq(chatThreadEvents.userId, args.userId),
          eq(chatThreadEvents.orgId, args.orgId),
          exists(
            db
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.id, chatThreadEvents.agentId)),
          ),
        ),
      )
      .orderBy(asc(chatThreadEvents.seqId))
      .limit(CHAT_THREAD_EVENTS_PAGE_SIZE + 1);
  }

  const visibleRows = rows.filter(hasCanonicalAgentReference);
  return {
    kind: "ok",
    events: visibleRows
      .slice(0, CHAT_THREAD_EVENTS_PAGE_SIZE)
      .map(toApiChatThreadEvent),
    hasMore: visibleRows.length > CHAT_THREAD_EVENTS_PAGE_SIZE,
  };
}
