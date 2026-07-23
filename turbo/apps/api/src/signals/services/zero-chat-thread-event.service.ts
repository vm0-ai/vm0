import { and, asc, eq, gt, gte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  chatThreadEvents,
  type ChatThreadEventKind,
} from "@vm0/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@vm0/db/schema/chat-thread-snapshot";

import type { Db, ReadonlyDb } from "../external/db";
import {
  excludeCanonicalSlackChatThreads,
  hiddenCanonicalSlackChatThreadIds,
} from "./canonical-slack-web-visibility.service";

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
      ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
    })
    .onConflictDoNothing({ target: chatThreadEvents.id });
}

export async function getChatThreadSnapshot(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly includeCanonicalSlackThreads?: boolean;
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

  const hiddenThreadIds = args.includeCanonicalSlackThreads
    ? new Set<string>()
    : await hiddenCanonicalSlackChatThreadIds(db, args.userId);
  return {
    chatThreads:
      snapshot?.chatThreads.flatMap((thread) => {
        if (hiddenThreadIds.has(thread.id)) {
          return [];
        }
        return {
          ...thread,
          selectedModel: thread.selectedModel ?? null,
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
  readonly createdAt: Date;
};

function toApiChatThreadEvent(row: ChatThreadEventRow): ChatThreadEvent {
  return {
    id: row.id,
    kind: row.kind,
    chatThreadId: row.chatThreadId,
    agentId: row.agentComposeId,
    title: row.title,
    selectedModel: row.selectedModel,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getChatThreadEventsSince(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly sinceEventId?: string;
    readonly includeCanonicalSlackThreads?: boolean;
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
          args.includeCanonicalSlackThreads
            ? undefined
            : excludeCanonicalSlackChatThreads(
                db,
                pageChatThreadEvent.chatThreadId,
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
        createdAt: chatThreadEvents.createdAt,
      })
      .from(chatThreadEvents)
      .where(
        and(
          eq(chatThreadEvents.userId, args.userId),
          eq(chatThreadEvents.orgId, args.orgId),
          args.includeCanonicalSlackThreads
            ? undefined
            : excludeCanonicalSlackChatThreads(
                db,
                chatThreadEvents.chatThreadId,
              ),
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
