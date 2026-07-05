import { command } from "ccstate";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreadEvents } from "@vm0/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@vm0/db/schema/chat-thread-snapshot";

import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";

interface SnapshotScope extends Record<string, unknown> {
  readonly userId: string;
  readonly orgId: string;
}

interface SnapshotCompactionStats {
  readonly scopes: number;
  readonly eventsApplied: number;
  readonly removedDeletedAgentThreads: number;
  readonly eventsPruned: number;
}

type SnapshotReadWriteDb = Pick<Db, "select" | "insert" | "execute">;
type SnapshotRootDb = SnapshotReadWriteDb & Pick<Db, "transaction">;
const CHAT_THREAD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function toApiEvent(row: {
  readonly id: string;
  readonly kind: ChatThreadEvent["kind"];
  readonly chatThreadId: string;
  readonly agentComposeId: string;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly createdAt: Date;
}): ChatThreadEvent {
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

function compareThreadOrder(
  left: ChatThreadSnapshotProjection,
  right: ChatThreadSnapshotProjection,
): number {
  const leftPinned = left.pinnedAt !== null;
  const rightPinned = right.pinnedAt !== null;
  if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }
  const sortCompare = right.sortAt.localeCompare(left.sortAt);
  if (sortCompare !== 0) {
    return sortCompare;
  }
  return right.id.localeCompare(left.id);
}

function applyChatThreadEvent(
  threads: Map<string, ChatThreadSnapshotProjection>,
  event: ChatThreadEvent,
) {
  if (event.kind === "created") {
    threads.set(event.chatThreadId, {
      id: event.chatThreadId,
      agentId: event.agentId,
      title: event.title,
      sortAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      pinnedAt: null,
      renamedAt: null,
      selectedModel: event.selectedModel,
    });
    return;
  }

  if (event.kind === "deleted") {
    threads.delete(event.chatThreadId);
    return;
  }

  const thread = threads.get(event.chatThreadId);
  if (!thread) {
    return;
  }

  if (event.kind === "renamed") {
    threads.set(event.chatThreadId, {
      ...thread,
      title: event.title,
      renamedAt: event.createdAt,
      updatedAt: event.createdAt,
    });
    return;
  }

  if (event.kind === "pinned") {
    threads.set(event.chatThreadId, {
      ...thread,
      pinnedAt: event.createdAt,
      updatedAt: event.createdAt,
    });
    return;
  }

  if (event.kind === "unpinned") {
    threads.set(event.chatThreadId, {
      ...thread,
      pinnedAt: null,
      updatedAt: event.createdAt,
    });
    return;
  }

  if (event.kind === "model_selection_updated") {
    threads.set(event.chatThreadId, {
      ...thread,
      selectedModel: event.selectedModel,
      updatedAt: event.createdAt,
    });
    return;
  }

  threads.set(event.chatThreadId, {
    ...thread,
    sortAt: event.createdAt,
  });
}

function compactSnapshot(
  snapshot: readonly ChatThreadSnapshotProjection[],
  events: readonly ChatThreadEvent[],
  liveAgentIds: ReadonlySet<string>,
): {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly removedDeletedAgentThreads: number;
} {
  const threads = new Map<string, ChatThreadSnapshotProjection>();
  for (const thread of snapshot) {
    threads.set(thread.id, {
      ...thread,
      selectedModel: thread.selectedModel ?? null,
    });
  }
  for (const event of events) {
    applyChatThreadEvent(threads, event);
  }

  let removedDeletedAgentThreads = 0;
  const chatThreads = [...threads.values()]
    .filter((thread) => {
      const keep = liveAgentIds.has(thread.agentId);
      if (!keep) {
        removedDeletedAgentThreads += 1;
      }
      return keep;
    })
    .sort(compareThreadOrder);

  return { chatThreads, removedDeletedAgentThreads };
}

async function loadSnapshotScopes(
  db: SnapshotReadWriteDb,
): Promise<SnapshotScope[]> {
  const rows = await db.execute<SnapshotScope>(sql`
    SELECT user_id AS "userId", org_id AS "orgId"
    FROM org_members_cache
    UNION
    SELECT user_id AS "userId", org_id AS "orgId"
    FROM org_members_metadata
    UNION
    SELECT chat_threads.user_id AS "userId", agent_composes.org_id AS "orgId"
    FROM chat_threads
    INNER JOIN agent_composes
      ON agent_composes.id = chat_threads.agent_compose_id
  `);
  return rows.rows;
}

async function loadSnapshot(
  db: SnapshotReadWriteDb,
  scope: SnapshotScope,
): Promise<{
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
}> {
  const [snapshot] = await db
    .select({
      chatThreads: chatThreadSnapshots.chatThreads,
      latestEventId: chatThreadSnapshots.latestEventId,
    })
    .from(chatThreadSnapshots)
    .where(
      and(
        eq(chatThreadSnapshots.userId, scope.userId),
        eq(chatThreadSnapshots.orgId, scope.orgId),
      ),
    )
    .limit(1);

  return {
    chatThreads: snapshot?.chatThreads ?? [],
    latestEventId: snapshot?.latestEventId ?? null,
  };
}

async function loadEventCursor(
  db: SnapshotReadWriteDb,
  scope: SnapshotScope,
  eventId: string | null,
): Promise<boolean> {
  if (!eventId) {
    return false;
  }

  const [row] = await db
    .select({
      id: chatThreadEvents.id,
      createdAt: chatThreadEvents.createdAt,
    })
    .from(chatThreadEvents)
    .where(
      and(
        eq(chatThreadEvents.userId, scope.userId),
        eq(chatThreadEvents.orgId, scope.orgId),
        eq(chatThreadEvents.id, eventId),
      ),
    )
    .limit(1);

  return row !== undefined;
}

async function loadEventsAfterMarker(
  db: SnapshotReadWriteDb,
  scope: SnapshotScope,
  eventId: string | null,
): Promise<readonly ChatThreadEvent[]> {
  const hasCursor = await loadEventCursor(db, scope, eventId);
  const filters: SQL[] = [
    eq(chatThreadEvents.userId, scope.userId),
    eq(chatThreadEvents.orgId, scope.orgId),
  ];
  if (hasCursor && eventId !== null) {
    filters.push(
      sql`(${chatThreadEvents.createdAt}, ${chatThreadEvents.id}) > (
        SELECT marker.created_at, marker.id
        FROM ${chatThreadEvents} AS marker
        WHERE marker.user_id = ${scope.userId}
          AND marker.org_id = ${scope.orgId}
          AND marker.id = ${eventId}
        LIMIT 1
      )`,
    );
  }

  const rows = await db
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
    .where(and(...filters))
    .orderBy(asc(chatThreadEvents.createdAt), asc(chatThreadEvents.id));

  return rows.map(toApiEvent);
}

async function loadLiveAgentIds(
  db: SnapshotReadWriteDb,
  orgId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.orgId, orgId));

  return new Set(
    rows.map((row) => {
      return row.id;
    }),
  );
}

async function writeSnapshot(
  db: SnapshotReadWriteDb,
  scope: SnapshotScope,
  chatThreads: readonly ChatThreadSnapshotProjection[],
  latestEventId: string | null,
): Promise<void> {
  const updatedAt = nowDate();
  await db
    .insert(chatThreadSnapshots)
    .values({
      userId: scope.userId,
      orgId: scope.orgId,
      latestEventId,
      chatThreads: [...chatThreads],
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [chatThreadSnapshots.userId, chatThreadSnapshots.orgId],
      set: {
        latestEventId,
        chatThreads: [...chatThreads],
        updatedAt,
      },
    });
}

async function compactChatThreadSnapshotsForAllScopes(
  db: SnapshotRootDb,
  signal?: AbortSignal,
): Promise<SnapshotCompactionStats> {
  const scopes = await loadSnapshotScopes(db);
  let eventsApplied = 0;
  let removedDeletedAgentThreads = 0;

  for (const scope of scopes) {
    signal?.throwIfAborted();
    const result = await db.transaction(
      async (tx) => {
        const snapshot = await loadSnapshot(tx, scope);
        const events = await loadEventsAfterMarker(
          tx,
          scope,
          snapshot.latestEventId,
        );
        const liveAgentIds = await loadLiveAgentIds(tx, scope.orgId);
        signal?.throwIfAborted();

        const compacted = compactSnapshot(
          snapshot.chatThreads,
          events,
          liveAgentIds,
        );
        const latestEventId =
          events.length > 0
            ? events[events.length - 1]!.id
            : snapshot.latestEventId;
        await writeSnapshot(tx, scope, compacted.chatThreads, latestEventId);

        return {
          eventsApplied: events.length,
          removedDeletedAgentThreads: compacted.removedDeletedAgentThreads,
        };
      },
      { isolationLevel: "repeatable read" },
    );

    eventsApplied += result.eventsApplied;
    removedDeletedAgentThreads += result.removedDeletedAgentThreads;
  }

  signal?.throwIfAborted();
  const cutoff = new Date(nowDate().getTime() - CHAT_THREAD_EVENT_RETENTION_MS);
  const pruned = await db.execute<{ readonly count: number }>(sql`
    WITH pruned AS (
      DELETE FROM ${chatThreadEvents}
      WHERE ${chatThreadEvents.createdAt} < ${cutoff}
        AND NOT EXISTS (
          SELECT 1
          FROM ${chatThreadSnapshots}
          WHERE ${chatThreadSnapshots.latestEventId} = ${chatThreadEvents.id}
        )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS "count"
    FROM pruned
  `);

  return {
    scopes: scopes.length,
    eventsApplied,
    removedDeletedAgentThreads,
    eventsPruned: pruned.rows[0]?.count ?? 0,
  };
}

export const compactChatThreadSnapshots$ = command(
  async ({ set }, signal: AbortSignal): Promise<SnapshotCompactionStats> => {
    return await compactChatThreadSnapshotsForAllScopes(set(writeDb$), signal);
  },
);
