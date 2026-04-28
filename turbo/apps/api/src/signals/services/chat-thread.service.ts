import { computed, type Computed } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  type ChatMessageV1,
  type ChatThreadV1,
} from "@vm0/api-contracts/contracts/chat-threads-v1";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db$ } from "../external/db";

const messageRoleSchema = z.enum(["user", "assistant"]);

interface MessageRow {
  readonly id: string;
  readonly role: string;
  readonly content: string | null;
  readonly error: string | null;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly runError: string | null;
}

const messageColumns = Object.freeze({
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  error: chatMessages.error,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  runError: agentRuns.error,
});

function toV1Message(row: MessageRow): ChatMessageV1 {
  // Legacy placeholder rows (sequence_number IS NULL, no error column) fall back
  // to runError. Event-backed and error rows surface their own error column —
  // never inheriting the run-level error, which would mask intermediate
  // assistant turns when a long-running session times out.
  const isLegacyPlaceholder =
    row.sequenceNumber === null && row.content === null && !row.error;
  const effectiveError = isLegacyPlaceholder
    ? (row.runError ?? undefined)
    : (row.error ?? undefined);
  return {
    id: row.id,
    role: messageRoleSchema.parse(row.role),
    content: row.content,
    error: effectiveError,
    createdAt: row.createdAt.toISOString(),
  };
}

export function ownedChatThreadV1(
  threadId: string,
  userId: string,
): Computed<Promise<ChatThreadV1 | null>> {
  return computed(async (get): Promise<ChatThreadV1 | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        id: chatThreads.id,
        title: chatThreads.title,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
      })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

interface ChatThreadMessagesV1Args {
  readonly threadId: string;
  readonly userId: string;
  readonly sinceId: string | undefined;
  readonly beforeId: string | undefined;
  readonly limit: number;
}

export function chatThreadMessagesV1(
  args: ChatThreadMessagesV1Args,
): Computed<Promise<readonly ChatMessageV1[] | null>> {
  return computed(async (get): Promise<readonly ChatMessageV1[] | null> => {
    if (args.sinceId !== undefined && args.beforeId !== undefined) {
      throw new Error("sinceId and beforeId are mutually exclusive");
    }

    const db = get(db$);

    // Ownership check — null result means "thread does not exist OR caller does
    // not own it". Both collapse to 404 at the route layer so existence does
    // not leak across users.
    const [owned] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    if (!owned) {
      return null;
    }

    const threadFilter = eq(chatMessages.chatThreadId, args.threadId);

    if (args.sinceId === undefined && args.beforeId === undefined) {
      const rows = await db
        .select(messageColumns)
        .from(chatMessages)
        .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
        .where(threadFilter)
        .orderBy(
          desc(chatMessages.createdAt),
          desc(chatMessages.sequenceNumber),
        )
        .limit(args.limit);
      return rows.reverse().map(toV1Message);
    }

    const cursorId = args.sinceId ?? args.beforeId;
    const cursorAfter = sql`(
      ${chatMessages.createdAt},
      COALESCE(${chatMessages.sequenceNumber}, -1)
    ) > (
      SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
      FROM ${chatMessages}
      WHERE ${chatMessages.id} = ${cursorId}
    )`;
    const cursorBefore = sql`(
      ${chatMessages.createdAt},
      COALESCE(${chatMessages.sequenceNumber}, -1)
    ) < (
      SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
      FROM ${chatMessages}
      WHERE ${chatMessages.id} = ${cursorId}
    )`;

    if (args.sinceId !== undefined) {
      const rows = await db
        .select(messageColumns)
        .from(chatMessages)
        .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
        .where(and(threadFilter, cursorAfter))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber))
        .limit(args.limit);
      return rows.map(toV1Message);
    }

    const rows = await db
      .select(messageColumns)
      .from(chatMessages)
      .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
      .where(and(threadFilter, cursorBefore))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
      .limit(args.limit);
    return rows.reverse().map(toV1Message);
  });
}
