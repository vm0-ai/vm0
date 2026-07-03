import { and, asc, eq, sql } from "drizzle-orm";
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

type ChatThreadEventDb = Pick<Db, "insert" | "select">;
const CHAT_THREAD_EVENTS_PAGE_SIZE = 1000;

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
    chatThreads: snapshot?.chatThreads ?? [],
    latestEventId: snapshot?.latestEventId ?? null,
  };
}

function toApiChatThreadEvent(row: {
  readonly id: string;
  readonly kind: ChatThreadEventKind;
  readonly chatThreadId: string;
  readonly agentComposeId: string;
  readonly title: string | null;
  readonly createdAt: Date;
}): ChatThreadEvent {
  return {
    id: row.id,
    kind: row.kind,
    chatThreadId: row.chatThreadId,
    agentId: row.agentComposeId,
    title: row.title,
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
  let cursor:
    | {
        readonly id: string;
        readonly createdAt: Date;
      }
    | undefined;

  if (args.sinceEventId !== undefined) {
    const [row] = await db
      .select({
        id: chatThreadEvents.id,
        createdAt: chatThreadEvents.createdAt,
      })
      .from(chatThreadEvents)
      .where(
        and(
          eq(chatThreadEvents.userId, args.userId),
          eq(chatThreadEvents.orgId, args.orgId),
          eq(chatThreadEvents.id, args.sinceEventId),
        ),
      )
      .limit(1);
    if (!row) {
      return { kind: "expired" };
    }
    cursor = row;
  }

  const filters = [
    eq(chatThreadEvents.userId, args.userId),
    eq(chatThreadEvents.orgId, args.orgId),
  ];
  if (cursor) {
    filters.push(sql`(${chatThreadEvents.createdAt}, ${chatThreadEvents.id}) >
      (${cursor.createdAt}, ${cursor.id})`);
  }

  const rows = await db
    .select({
      id: chatThreadEvents.id,
      kind: chatThreadEvents.kind,
      chatThreadId: chatThreadEvents.chatThreadId,
      agentComposeId: chatThreadEvents.agentComposeId,
      title: chatThreadEvents.title,
      createdAt: chatThreadEvents.createdAt,
    })
    .from(chatThreadEvents)
    .where(and(...filters))
    .orderBy(asc(chatThreadEvents.createdAt), asc(chatThreadEvents.id))
    .limit(CHAT_THREAD_EVENTS_PAGE_SIZE + 1);

  return {
    kind: "ok",
    events: rows
      .slice(0, CHAT_THREAD_EVENTS_PAGE_SIZE)
      .map(toApiChatThreadEvent),
    hasMore: rows.length > CHAT_THREAD_EVENTS_PAGE_SIZE,
  };
}
