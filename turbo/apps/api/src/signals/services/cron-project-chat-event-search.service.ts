import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  gte,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import {
  chatEventSearchDocs,
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
  chatEventSearchWatermarks,
} from "@vm0/db/schema/chat-event-search";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatSearchIndexText } from "../../lib/chat-search-bigram";
import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { writeDb$, type Db } from "../external/db";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { visibleChatEventCondition } from "./zero-chat-event-shared.service";

interface ChatEventSearchProjectionStats {
  readonly threads: number;
  readonly indexedEvents: number;
  readonly deletedDocs: number;
  readonly durableThreads: number;
  readonly durableIndexedMessages: number;
  readonly durableDeletedMessages: number;
  readonly convergence: ChatEventSearchProjectionConvergence;
}

interface ChatEventSearchProjectionConvergence {
  readonly eligibleThreads: number;
  readonly legacyCaughtUpThreads: number;
  readonly durableCaughtUpThreads: number;
}

interface CandidateThread {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId: string;
}

interface ThreadProjectionStats {
  readonly legacyThread: number;
  readonly legacyIndexedEvents: number;
  readonly legacyDeletedDocs: number;
  readonly durableThread: number;
  readonly durableIndexedMessages: number;
  readonly durableDeletedMessages: number;
}

interface SearchMessageProjection {
  readonly role: SearchableRole;
  readonly text: string;
  readonly textBigram: string;
}

interface ThreadProjectionProgress {
  readonly legacyLagging: boolean;
  readonly durableLagging: boolean;
  readonly legacyRows: readonly ProjectionRow[];
  readonly durableRows: readonly ProjectionRow[];
}

interface SearchProjectionBatch {
  readonly legacyDocs: LegacySearchDocInsert[];
  readonly durableMessages: DurableSearchMessageInsert[];
  readonly revokedEventIds: string[];
}

interface SearchProjectionWriteStats {
  readonly legacyIndexedEvents: number;
  readonly legacyDeletedDocs: number;
  readonly durableIndexedMessages: number;
  readonly durableDeletedMessages: number;
}

type SearchableRole = "user" | "assistant";
type LegacySearchDocInsert = typeof chatEventSearchDocs.$inferInsert;
type DurableSearchMessageInsert = typeof chatEventSearchMessages.$inferInsert;

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

function searchDocText(row: {
  readonly eventType: (typeof chatEvents.$inferSelect)["eventType"];
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
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

function searchMessageProjection(row: {
  readonly eventType: (typeof chatEvents.$inferSelect)["eventType"];
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
}): SearchMessageProjection | null {
  const role = searchDocRole(row.eventType);
  if (role === null) {
    return null;
  }
  const text = searchDocText(row);
  if (text === null) {
    return null;
  }
  return { role, text, textBigram: chatSearchIndexText(text) };
}

async function loadProjectionRows(
  tx: Tx,
  chatThreadId: string,
  indexedSeqId: number,
) {
  return await tx
    .select({
      id: chatEvents.id,
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventContent(),
      userMessage: canonicalChatEventUserMessage(),
      revokesEventId: chatEvents.revokesEventId,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        gt(chatEvents.seqId, indexedSeqId),
      ),
    )
    .orderBy(asc(chatEvents.seqId))
    .limit(THREAD_EVENT_LIMIT);
}

type ProjectionRow = Awaited<ReturnType<typeof loadProjectionRows>>[number];

function nextProjectionWatermark(
  rows: readonly ProjectionRow[],
  lastChatEventSeqId: number,
): number {
  const lastRow = rows[rows.length - 1];
  return rows.length < THREAD_EVENT_LIMIT
    ? Math.max(lastRow?.seqId ?? 0, lastChatEventSeqId)
    : (lastRow?.seqId ?? lastChatEventSeqId);
}

async function visibleSearchEventIds(
  tx: Tx,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) {
    return new Set();
  }
  const rows = await tx
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(inArray(chatEvents.id, [...eventIds]), visibleChatEventCondition(tx)),
    );
  return new Set(
    rows.map((row) => {
      return row.id;
    }),
  );
}

async function lockProjectionThread(
  tx: Tx,
  chatThreadId: string,
): Promise<{ readonly lastChatEventSeqId: number } | null> {
  // An update lock keeps the parent alive and serializes overlapping projector
  // ticks, so a stale tick cannot resurrect a row after a revoker.
  const [thread] = await tx
    .select({ lastChatEventSeqId: chatThreads.lastChatEventSeqId })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .for("update")
    .limit(1);
  return thread ?? null;
}

async function loadThreadProjectionProgress(
  tx: Tx,
  chatThreadId: string,
  lastChatEventSeqId: number,
): Promise<ThreadProjectionProgress> {
  const [progress] = await tx
    .select({
      legacyIndexedSeqId: chatEventSearchWatermarks.indexedSeqId,
      durableIndexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId,
    })
    .from(chatThreads)
    .leftJoin(
      chatEventSearchWatermarks,
      eq(chatEventSearchWatermarks.chatThreadId, chatThreads.id),
    )
    .leftJoin(
      chatEventSearchMessageWatermarks,
      eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
    )
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!progress) {
    throw new Error("Locked chat search projection thread disappeared");
  }
  const legacyIndexedSeqId = progress.legacyIndexedSeqId ?? 0;
  const durableIndexedSeqId = progress.durableIndexedSeqId ?? 0;
  const legacyLagging = lastChatEventSeqId > legacyIndexedSeqId;
  const durableLagging = lastChatEventSeqId > durableIndexedSeqId;
  const legacyRows = legacyLagging
    ? await loadProjectionRows(tx, chatThreadId, legacyIndexedSeqId)
    : [];
  const durableRows = durableLagging
    ? legacyLagging && durableIndexedSeqId === legacyIndexedSeqId
      ? legacyRows
      : await loadProjectionRows(tx, chatThreadId, durableIndexedSeqId)
    : [];
  return { legacyLagging, durableLagging, legacyRows, durableRows };
}

function collectSearchMessageProjections(
  legacyRows: readonly ProjectionRow[],
  durableRows: readonly ProjectionRow[],
): {
  readonly projectionByEventId: ReadonlyMap<string, SearchMessageProjection>;
  readonly revokedEventIds: Set<string>;
} {
  const revokedEventIds = new Set<string>();
  const projectionByEventId = new Map<string, SearchMessageProjection>();
  for (const rows of [legacyRows, durableRows]) {
    for (const row of rows) {
      if (row.revokesEventId !== null) {
        revokedEventIds.add(row.revokesEventId);
      }
      if (!projectionByEventId.has(row.id)) {
        const projection = searchMessageProjection(row);
        if (projection !== null) {
          projectionByEventId.set(row.id, projection);
        }
      }
    }
  }
  return { projectionByEventId, revokedEventIds };
}

function legacySearchDoc(
  row: ProjectionRow,
  thread: CandidateThread,
  projections: ReadonlyMap<string, SearchMessageProjection>,
  visibleEventIds: ReadonlySet<string>,
): LegacySearchDocInsert | null {
  const projection = projections.get(row.id);
  if (!projection || !visibleEventIds.has(row.id)) {
    return null;
  }
  return {
    eventId: row.id,
    chatThreadId: thread.chatThreadId,
    orgId: thread.orgId,
    userId: thread.userId,
    agentComposeId: thread.agentComposeId,
    role: projection.role,
    createdAt: row.createdAt,
    text: projection.text,
    textBigram: projection.textBigram,
  };
}

function durableSearchMessage(
  row: ProjectionRow,
  thread: CandidateThread,
  projections: ReadonlyMap<string, SearchMessageProjection>,
  visibleEventIds: ReadonlySet<string>,
): DurableSearchMessageInsert | null {
  const projection = projections.get(row.id);
  if (!projection || !visibleEventIds.has(row.id)) {
    return null;
  }
  return {
    chatThreadId: thread.chatThreadId,
    seqId: row.seqId,
    runId: row.runId,
    orgId: thread.orgId,
    userId: thread.userId,
    agentComposeId: thread.agentComposeId,
    role: projection.role,
    createdAt: row.createdAt,
    text: projection.text,
    textBigram: projection.textBigram,
  };
}

async function buildSearchProjectionBatch(
  tx: Tx,
  thread: CandidateThread,
  progress: ThreadProjectionProgress,
): Promise<SearchProjectionBatch> {
  // Any event type can revoke an earlier one. Resolve every target before
  // chat_events retention can remove its stable thread/sequence coordinate.
  const { projectionByEventId, revokedEventIds } =
    collectSearchMessageProjections(progress.legacyRows, progress.durableRows);
  const visibleEventIds = await visibleSearchEventIds(tx, [
    ...projectionByEventId.keys(),
  ]);
  return {
    legacyDocs: progress.legacyRows.flatMap((row) => {
      const doc = legacySearchDoc(
        row,
        thread,
        projectionByEventId,
        visibleEventIds,
      );
      return doc ? [doc] : [];
    }),
    durableMessages: progress.durableRows.flatMap((row) => {
      const message = durableSearchMessage(
        row,
        thread,
        projectionByEventId,
        visibleEventIds,
      );
      return message ? [message] : [];
    }),
    revokedEventIds: [...revokedEventIds],
  };
}

async function insertLegacySearchDocs(
  tx: Tx,
  docs: readonly LegacySearchDocInsert[],
): Promise<number> {
  if (docs.length === 0) {
    return 0;
  }
  const indexed = await tx
    .insert(chatEventSearchDocs)
    .values([...docs])
    .onConflictDoNothing({ target: chatEventSearchDocs.eventId })
    .returning({ eventId: chatEventSearchDocs.eventId });
  return indexed.length;
}

async function insertDurableSearchMessages(
  tx: Tx,
  messages: readonly DurableSearchMessageInsert[],
): Promise<number> {
  if (messages.length === 0) {
    return 0;
  }
  const indexed = await tx
    .insert(chatEventSearchMessages)
    .values([...messages])
    .onConflictDoNothing({
      target: [
        chatEventSearchMessages.chatThreadId,
        chatEventSearchMessages.seqId,
      ],
    })
    .returning({ seqId: chatEventSearchMessages.seqId });
  return indexed.length;
}

async function deleteLegacyRevokedDocs(
  tx: Tx,
  revokedEventIds: readonly string[],
): Promise<number> {
  if (revokedEventIds.length === 0) {
    return 0;
  }
  const deleted = await tx
    .delete(chatEventSearchDocs)
    .where(inArray(chatEventSearchDocs.eventId, [...revokedEventIds]))
    .returning({ eventId: chatEventSearchDocs.eventId });
  return deleted.length;
}

async function deleteDurableRevokedMessages(
  tx: Tx,
  revokedEventIds: readonly string[],
): Promise<number> {
  if (revokedEventIds.length === 0) {
    return 0;
  }
  const deleted = await tx
    .delete(chatEventSearchMessages)
    .where(
      exists(
        tx
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(
            and(
              inArray(chatEvents.id, [...revokedEventIds]),
              eq(chatEvents.chatThreadId, chatEventSearchMessages.chatThreadId),
              eq(chatEvents.seqId, chatEventSearchMessages.seqId),
            ),
          ),
      ),
    )
    .returning({
      chatThreadId: chatEventSearchMessages.chatThreadId,
      seqId: chatEventSearchMessages.seqId,
    });
  return deleted.length;
}

async function writeSearchProjectionBatch(
  tx: Tx,
  batch: SearchProjectionBatch,
): Promise<SearchProjectionWriteStats> {
  const legacyIndexedEvents = await insertLegacySearchDocs(
    tx,
    batch.legacyDocs,
  );
  const durableIndexedMessages = await insertDurableSearchMessages(
    tx,
    batch.durableMessages,
  );
  const legacyDeletedDocs = await deleteLegacyRevokedDocs(
    tx,
    batch.revokedEventIds,
  );
  const durableDeletedMessages = await deleteDurableRevokedMessages(
    tx,
    batch.revokedEventIds,
  );
  return {
    legacyIndexedEvents,
    legacyDeletedDocs,
    durableIndexedMessages,
    durableDeletedMessages,
  };
}

async function advanceProjectionWatermarks(
  tx: Tx,
  chatThreadId: string,
  lastChatEventSeqId: number,
  progress: ThreadProjectionProgress,
): Promise<void> {
  if (progress.legacyLagging) {
    await tx
      .insert(chatEventSearchWatermarks)
      .values({
        chatThreadId,
        indexedSeqId: nextProjectionWatermark(
          progress.legacyRows,
          lastChatEventSeqId,
        ),
      })
      .onConflictDoUpdate({
        target: chatEventSearchWatermarks.chatThreadId,
        set: {
          indexedSeqId: sql`GREATEST(${chatEventSearchWatermarks.indexedSeqId}, EXCLUDED.indexed_seq_id)`,
        },
      });
  }
  if (progress.durableLagging) {
    await tx
      .insert(chatEventSearchMessageWatermarks)
      .values({
        chatThreadId,
        indexedSeqId: nextProjectionWatermark(
          progress.durableRows,
          lastChatEventSeqId,
        ),
      })
      .onConflictDoUpdate({
        target: chatEventSearchMessageWatermarks.chatThreadId,
        set: {
          indexedSeqId: sql`GREATEST(${chatEventSearchMessageWatermarks.indexedSeqId}, EXCLUDED.indexed_seq_id)`,
        },
      });
  }
}

function emptyThreadProjectionStats(): ThreadProjectionStats {
  return {
    legacyThread: 0,
    legacyIndexedEvents: 0,
    legacyDeletedDocs: 0,
    durableThread: 0,
    durableIndexedMessages: 0,
    durableDeletedMessages: 0,
  };
}

async function projectThread(
  db: Db,
  thread: CandidateThread,
): Promise<ThreadProjectionStats> {
  return await db.transaction(async (tx) => {
    const lockedThread = await lockProjectionThread(tx, thread.chatThreadId);
    if (!lockedThread) {
      return emptyThreadProjectionStats();
    }
    const progress = await loadThreadProjectionProgress(
      tx,
      thread.chatThreadId,
      lockedThread.lastChatEventSeqId,
    );

    const batch = await buildSearchProjectionBatch(tx, thread, progress);
    const writes = await writeSearchProjectionBatch(tx, batch);
    await advanceProjectionWatermarks(
      tx,
      thread.chatThreadId,
      lockedThread.lastChatEventSeqId,
      progress,
    );

    return {
      legacyThread: progress.legacyLagging ? 1 : 0,
      legacyIndexedEvents: writes.legacyIndexedEvents,
      legacyDeletedDocs: writes.legacyDeletedDocs,
      durableThread: progress.durableLagging ? 1 : 0,
      durableIndexedMessages: writes.durableIndexedMessages,
      durableDeletedMessages: writes.durableDeletedMessages,
    };
  });
}

async function projectionConvergence(
  db: Pick<Db, "select">,
): Promise<ChatEventSearchProjectionConvergence> {
  const [stats] = await db
    .select({
      eligibleThreads: count(),
      legacyCaughtUpThreads: count(chatEventSearchWatermarks.chatThreadId),
      durableCaughtUpThreads: count(
        chatEventSearchMessageWatermarks.chatThreadId,
      ),
    })
    .from(chatThreads)
    .leftJoin(
      chatEventSearchWatermarks,
      and(
        eq(chatEventSearchWatermarks.chatThreadId, chatThreads.id),
        gte(
          chatEventSearchWatermarks.indexedSeqId,
          chatThreads.lastChatEventSeqId,
        ),
      ),
    )
    .leftJoin(
      chatEventSearchMessageWatermarks,
      and(
        eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
        gte(
          chatEventSearchMessageWatermarks.indexedSeqId,
          chatThreads.lastChatEventSeqId,
        ),
      ),
    )
    .where(gt(chatThreads.lastChatEventSeqId, 0));
  if (!stats) {
    throw new Error("Chat search projection convergence query returned no row");
  }
  return stats;
}

/**
 * Advances both per-thread chat search projections. Each projection owns its
 * watermark and can backfill independently from zero; the outer union remains
 * bounded, while per-thread locking and conflict-safe inserts make overlapping
 * cron ticks idempotent.
 */
export const projectChatEventSearch$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    const candidateThreads = await db
      .select({
        chatThreadId: chatThreads.id,
        userId: chatThreads.userId,
        orgId: agentComposes.orgId,
        agentComposeId: chatThreads.agentComposeId,
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
      .leftJoin(
        chatEventSearchMessageWatermarks,
        eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
      )
      .where(
        or(
          gt(
            chatThreads.lastChatEventSeqId,
            sql`COALESCE(${chatEventSearchWatermarks.indexedSeqId}, 0)`,
          ),
          gt(
            chatThreads.lastChatEventSeqId,
            sql`COALESCE(${chatEventSearchMessageWatermarks.indexedSeqId}, 0)`,
          ),
        ),
      )
      // Keep the serving legacy projection fresh while the durable projection
      // works through its zero-based backfill in the remaining bounded slots.
      .orderBy(
        asc(
          sql`CASE WHEN ${chatThreads.lastChatEventSeqId} > COALESCE(${chatEventSearchWatermarks.indexedSeqId}, 0) THEN 0 ELSE 1 END`,
        ),
        asc(chatThreads.id),
      )
      .limit(chatEventSearchThreadBatchSize());
    signal.throwIfAborted();

    let threads = 0;
    let indexedEvents = 0;
    let deletedDocs = 0;
    let durableThreads = 0;
    let durableIndexedMessages = 0;
    let durableDeletedMessages = 0;
    for (const thread of candidateThreads) {
      const stats = await projectThread(db, thread);
      signal.throwIfAborted();
      threads += stats.legacyThread;
      indexedEvents += stats.legacyIndexedEvents;
      deletedDocs += stats.legacyDeletedDocs;
      durableThreads += stats.durableThread;
      durableIndexedMessages += stats.durableIndexedMessages;
      durableDeletedMessages += stats.durableDeletedMessages;
    }
    const convergence = await projectionConvergence(db);
    signal.throwIfAborted();
    return {
      threads,
      indexedEvents,
      deletedDocs,
      durableThreads,
      durableIndexedMessages,
      durableDeletedMessages,
      convergence,
    };
  },
);
