import { command } from "ccstate";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  chatEventSearchDocs,
  chatEventSearchWatermarks,
} from "@vm0/db/schema/chat-event-search";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatSearchIndexText } from "../../lib/chat-search-bigram";
import { executeRawRows } from "../../lib/db-raw-rows";
import { optionalEnv } from "../../lib/env";
import { writeDb$, type Db } from "../external/db";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";

interface ChatEventSearchProjectionStats {
  readonly threads: number;
  readonly indexedEvents: number;
  readonly deletedDocs: number;
}

interface LaggingThread {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly lastChatEventSeqId: number;
  readonly indexedSeqId: number | null;
}

type SearchableRole = "user" | "assistant";

const DEFAULT_THREAD_BATCH_SIZE = 500;
const THREAD_EVENT_LIMIT = 1000;

function chatEventSearchThreadBatchSize(): number {
  const raw = optionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_THREAD_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

function searchDocRole(eventType: string): SearchableRole | null {
  if (eventType === "input.prompt" || eventType === "input.rejected") {
    return "user";
  }
  if (eventType === "output.message") {
    return "assistant";
  }
  return null;
}

const searchDocsReadyRowSchema = z.object({ ready: z.boolean() });

function searchDocText(row: {
  readonly eventType: (typeof chatEvents.$inferSelect)["eventType"];
  readonly content: string | null;
  readonly userMessage: (typeof chatEvents.$inferSelect)["userMessage"];
}): string | null {
  const userMessage = requiredUserMessageForEvent(
    row.eventType,
    row.userMessage,
  );
  const text = userMessage
    ? projectUserMessage(userMessage).displayText
    : row.content;
  const trimmed = text?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

async function projectThread(
  db: Db,
  thread: LaggingThread,
): Promise<{ readonly indexedEvents: number; readonly deletedDocs: number }> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: chatEvents.id,
        eventType: chatEvents.eventType,
        content: chatEvents.content,
        userMessage: chatEvents.userMessage,
        revokesEventId: chatEvents.revokesEventId,
        seqId: chatEvents.seqId,
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, thread.chatThreadId),
          gt(chatEvents.seqId, thread.indexedSeqId ?? 0),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(THREAD_EVENT_LIMIT);

    const revokedEventIds = new Set<string>();
    for (const row of rows) {
      if (row.eventType === "control.revoke" && row.revokesEventId !== null) {
        revokedEventIds.add(row.revokesEventId);
      }
    }

    const docs = rows.flatMap((row) => {
      const role = searchDocRole(row.eventType);
      if (role === null || revokedEventIds.has(row.id)) {
        return [];
      }
      const text = searchDocText(row);
      if (text === null) {
        return [];
      }
      return [
        {
          eventId: row.id,
          chatThreadId: thread.chatThreadId,
          orgId: thread.orgId,
          userId: thread.userId,
          role,
          createdAt: row.createdAt,
          text,
          textBigram: chatSearchIndexText(text),
        },
      ];
    });

    const indexed =
      docs.length > 0
        ? await tx
            .insert(chatEventSearchDocs)
            .values(docs)
            .onConflictDoNothing({ target: chatEventSearchDocs.eventId })
            .returning({ eventId: chatEventSearchDocs.eventId })
        : [];

    const deleted =
      revokedEventIds.size > 0
        ? await tx
            .delete(chatEventSearchDocs)
            .where(inArray(chatEventSearchDocs.eventId, [...revokedEventIds]))
            .returning({ eventId: chatEventSearchDocs.eventId })
        : [];

    const lastRow = rows[rows.length - 1];
    const nextWatermark =
      rows.length < THREAD_EVENT_LIMIT
        ? Math.max(lastRow?.seqId ?? 0, thread.lastChatEventSeqId)
        : (lastRow?.seqId ?? thread.lastChatEventSeqId);
    await tx
      .insert(chatEventSearchWatermarks)
      .values({
        chatThreadId: thread.chatThreadId,
        indexedSeqId: nextWatermark,
      })
      .onConflictDoUpdate({
        target: chatEventSearchWatermarks.chatThreadId,
        set: {
          indexedSeqId: sql`GREATEST(${chatEventSearchWatermarks.indexedSeqId}, EXCLUDED.indexed_seq_id)`,
        },
      });

    return { indexedEvents: indexed.length, deletedDocs: deleted.length };
  });
}

/**
 * Advances the per-thread chat search projection: finds threads whose
 * chat_events tail is ahead of the search watermark and mirrors their new
 * user prompts and assistant messages into chat_event_search_docs. Bounded
 * batches keep one run short; the initial backfill is the same loop starting
 * from watermark 0. Ticks are idempotent (docs upsert by event id, watermark
 * only moves forward), so overlapping runs are safe.
 */
export const projectChatEventSearch$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    // New-code-before-migration guard: this cron starts ticking as soon as the
    // new API is promoted, which can precede migration 0859 under promotion
    // drift or rollback (DB/API skew, observed up to ~102 minutes). Remove
    // after migration 0859 is outside the production rollback window.
    const [relation] = await executeRawRows(
      db,
      sql`SELECT to_regclass('public.chat_event_search_docs') IS NOT NULL AS ready`,
      searchDocsReadyRowSchema,
    );
    signal.throwIfAborted();
    if (!relation?.ready) {
      return { threads: 0, indexedEvents: 0, deletedDocs: 0 };
    }
    const laggingThreads = await db
      .select({
        chatThreadId: chatThreads.id,
        userId: chatThreads.userId,
        orgId: agentComposes.orgId,
        lastChatEventSeqId: chatThreads.lastChatEventSeqId,
        indexedSeqId: chatEventSearchWatermarks.indexedSeqId,
      })
      .from(chatThreads)
      .innerJoin(
        agentComposes,
        eq(chatThreads.agentComposeId, agentComposes.id),
      )
      .leftJoin(
        chatEventSearchWatermarks,
        eq(chatEventSearchWatermarks.chatThreadId, chatThreads.id),
      )
      .where(
        gt(
          chatThreads.lastChatEventSeqId,
          sql`COALESCE(${chatEventSearchWatermarks.indexedSeqId}, 0)`,
        ),
      )
      .orderBy(asc(chatThreads.id))
      .limit(chatEventSearchThreadBatchSize());
    signal.throwIfAborted();

    let indexedEvents = 0;
    let deletedDocs = 0;
    for (const thread of laggingThreads) {
      const stats = await projectThread(db, thread);
      signal.throwIfAborted();
      indexedEvents += stats.indexedEvents;
      deletedDocs += stats.deletedDocs;
    }
    return { threads: laggingThreads.length, indexedEvents, deletedDocs };
  },
);
