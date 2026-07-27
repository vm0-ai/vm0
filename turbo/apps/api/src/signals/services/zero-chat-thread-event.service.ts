import { and, asc, eq, gt, gte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  ChatThreadEvent,
  ChatThreadServiceTier,
  ChatThreadSnapshotProjection,
  CodexServiceTier,
} from "@vm0/api-contracts/contracts/chat-threads";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  chatThreadEvents,
  type ChatThreadEventKind,
} from "@vm0/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@vm0/db/schema/chat-thread-snapshot";

import type { Db, ReadonlyDb } from "../external/db";

type ChatThreadEventDb = Pick<Db, "insert" | "select">;
const CHAT_THREAD_EVENTS_PAGE_SIZE = 1000;
const cursorChatThreadEvent = alias(
  chatThreadEvents,
  "cursor_chat_thread_event",
);
const pageChatThreadEvent = alias(chatThreadEvents, "page_chat_thread_event");

export async function appendChatThreadEvent(
  db: ChatThreadEventDb,
  args: {
    readonly kind: ChatThreadEventKind;
    readonly userId: string;
    readonly orgId?: string | null;
    readonly chatThreadId: string;
    readonly agentComposeId: string;
    readonly eventId?: string;
    readonly title?: string | null;
    readonly selectedModel?: string | null;
    readonly serviceTier?: ChatThreadServiceTier | null;
    readonly computerUseHostId?: string | null;
    readonly cloudBrowserEnabled?: boolean;
    readonly createdAt?: Date;
  },
): Promise<void> {
  let orgId = args.orgId ?? undefined;
  if (orgId === undefined) {
    const [compose] = await db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, args.agentComposeId))
      .limit(1);
    orgId = compose?.orgId;
  }

  if (orgId === undefined) {
    throw new Error("Unable to resolve org for chat thread event");
  }

  await db
    .insert(chatThreadEvents)
    .values({
      ...(args.eventId !== undefined ? { id: args.eventId } : {}),
      userId: args.userId,
      orgId,
      chatThreadId: args.chatThreadId,
      kind: args.kind,
      agentComposeId: args.agentComposeId,
      title: args.title ?? null,
      selectedModel: args.selectedModel ?? null,
      serviceTier: args.serviceTier ?? null,
      computerUseHostId: args.computerUseHostId ?? null,
      cloudBrowserEnabled: args.cloudBrowserEnabled ?? false,
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
}> {
  const [snapshot] = await db
    .select({
      latestEventId: chatThreadSnapshots.latestEventId,
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
        };
      }) ?? [],
    latestEventId: snapshot?.latestEventId ?? null,
  };
}

type ChatThreadEventRow = {
  readonly id: string;
  readonly kind: ChatThreadEventKind;
  readonly chatThreadId: string;
  readonly agentComposeId: string;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly createdAt: Date;
};

export function chatThreadServiceTierFromCodex(
  codexServiceTier: CodexServiceTier | null,
): ChatThreadServiceTier | null {
  return codexServiceTier === "fast" ? "priority" : null;
}

function toApiChatThreadEvent(row: ChatThreadEventRow): ChatThreadEvent {
  return {
    id: row.id,
    kind: row.kind,
    chatThreadId: row.chatThreadId,
    agentId: row.agentComposeId,
    title: row.title,
    selectedModel: row.selectedModel,
    serviceTier: row.serviceTier,
    computerUseHostId: row.computerUseHostId,
    cloudBrowserEnabled: row.cloudBrowserEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getChatThreadEventsSince(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly sinceEventId?: string;
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
  if (args.sinceEventId !== undefined) {
    // Keep a valid cursor row when its page is empty while preserving the
    // composite event index's timestamp lower bound.
    const cursorRows = await db
      .select({
        event: {
          id: pageChatThreadEvent.id,
          kind: pageChatThreadEvent.kind,
          chatThreadId: pageChatThreadEvent.chatThreadId,
          agentComposeId: pageChatThreadEvent.agentComposeId,
          title: pageChatThreadEvent.title,
          selectedModel: pageChatThreadEvent.selectedModel,
          serviceTier: pageChatThreadEvent.serviceTier,
          computerUseHostId: pageChatThreadEvent.computerUseHostId,
          cloudBrowserEnabled: pageChatThreadEvent.cloudBrowserEnabled,
          createdAt: pageChatThreadEvent.createdAt,
        },
      })
      .from(cursorChatThreadEvent)
      .leftJoin(
        pageChatThreadEvent,
        and(
          eq(pageChatThreadEvent.userId, args.userId),
          eq(pageChatThreadEvent.orgId, args.orgId),
          gte(pageChatThreadEvent.createdAt, cursorChatThreadEvent.createdAt),
          or(
            gt(pageChatThreadEvent.createdAt, cursorChatThreadEvent.createdAt),
            and(
              eq(
                pageChatThreadEvent.createdAt,
                cursorChatThreadEvent.createdAt,
              ),
              gt(pageChatThreadEvent.id, cursorChatThreadEvent.id),
            ),
          ),
        ),
      )
      .where(
        and(
          eq(cursorChatThreadEvent.userId, args.userId),
          eq(cursorChatThreadEvent.orgId, args.orgId),
          eq(cursorChatThreadEvent.id, args.sinceEventId),
        ),
      )
      .orderBy(asc(pageChatThreadEvent.createdAt), asc(pageChatThreadEvent.id))
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
        kind: chatThreadEvents.kind,
        chatThreadId: chatThreadEvents.chatThreadId,
        agentComposeId: chatThreadEvents.agentComposeId,
        title: chatThreadEvents.title,
        selectedModel: chatThreadEvents.selectedModel,
        serviceTier: chatThreadEvents.serviceTier,
        computerUseHostId: chatThreadEvents.computerUseHostId,
        cloudBrowserEnabled: chatThreadEvents.cloudBrowserEnabled,
        createdAt: chatThreadEvents.createdAt,
      })
      .from(chatThreadEvents)
      .where(
        and(
          eq(chatThreadEvents.userId, args.userId),
          eq(chatThreadEvents.orgId, args.orgId),
        ),
      )
      .orderBy(asc(chatThreadEvents.createdAt), asc(chatThreadEvents.id))
      .limit(CHAT_THREAD_EVENTS_PAGE_SIZE + 1);
  }

  return {
    kind: "ok",
    events: rows
      .slice(0, CHAT_THREAD_EVENTS_PAGE_SIZE)
      .map(toApiChatThreadEvent),
    hasMore: rows.length > CHAT_THREAD_EVENTS_PAGE_SIZE,
  };
}
