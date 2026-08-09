import { randomUUID } from "node:crypto";

import { chatEventSearchWatermarks } from "@vm0/db/schema/chat-event-search";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@vm0/db/schema/chat-thread-event";
import { count, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { appendChatThreadEvent } from "../signals/services/zero-chat-thread-event.service";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

interface ChatThreadEventFixtureArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly agentComposeId: string;
  readonly title: string;
}

interface PersistedChatThreadEventFixture {
  readonly id: string;
  readonly seqId: number;
}

interface ScopeWritesPausedFixtureArgs<T> {
  readonly signal: AbortSignal;
  readonly run: () => Promise<T>;
}

async function withScopeWritesPausedFixture<T>(
  lockTables: SQL,
  args: ScopeWritesPausedFixtureArgs<T>,
): Promise<T> {
  const started = createDeferredPromise<void>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    await tx.execute(lockTables);
    started.resolve(undefined);
    await released.promise;
  });
  await started.promise;

  const result = await settleIncludingAbort(args.run());
  if (!released.settled()) {
    released.resolve(undefined);
  }
  await done;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Quiesces writes that can add or advance snapshot-compaction scopes while a
 * route test observes the global post-pass backlog. The compactor only reads
 * these tables, so its snapshot rebuild and pruning remain unblocked.
 */
export async function withChatThreadSnapshotScopeWritesPausedFixture<T>(args: {
  readonly signal: AbortSignal;
  readonly run: () => Promise<T>;
}): Promise<T> {
  return await withScopeWritesPausedFixture(
    sql`LOCK TABLE ${chatThreads}, ${chatThreadEventSequences} IN SHARE MODE`,
    args,
  );
}

/**
 * Quiesces writes that can add or advance snapshot-archiver targets while a
 * route test observes the global post-pass backlog. The archiver only reads
 * these tables, so publishing snapshot heads remains unblocked.
 */
export async function withChatEventSnapshotScopeWritesPausedFixture<T>(args: {
  readonly signal: AbortSignal;
  readonly run: () => Promise<T>;
}): Promise<T> {
  return await withScopeWritesPausedFixture(
    sql`LOCK TABLE ${chatThreads}, ${chatEventSearchWatermarks} IN SHARE MODE`,
    args,
  );
}

async function transitiveBlockedWaiterCount(
  holderPid: number,
): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      WITH RECURSIVE blocked("pid") AS (
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))

        UNION

        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT ${count()}::int AS "waiterCount"
      FROM blocked
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

/**
 * Appends an event through the production writer and pauses before commit.
 * Product endpoints cannot expose this boundary, so the fixture makes the
 * sequence-row lock observable to the concurrency regression test.
 */
export async function holdChatThreadEventInsertTransactionFixture(
  args: ChatThreadEventFixtureArgs & { readonly signal: AbortSignal },
): Promise<{
  readonly event: PersistedChatThreadEventFixture;
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly event: PersistedChatThreadEventFixture;
  }>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const eventId = randomUUID();
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-thread event insert holder pid");
    }
    await appendChatThreadEvent(tx, {
      eventId,
      kind: "renamed",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: args.chatThreadId,
      agentComposeId: args.agentComposeId,
      title: args.title,
    });
    const [event] = await tx
      .select({ id: chatThreadEvents.id, seqId: chatThreadEvents.seqId })
      .from(chatThreadEvents)
      .where(eq(chatThreadEvents.id, eventId))
      .limit(1);
    if (!event) {
      throw new Error("Expected the held chat-thread event insert");
    }
    started.resolve({ pid: holderPid, event });
    await released.promise;
  });
  const { pid, event } = await started.promise;

  return {
    event,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(pid);
    },
  };
}

/** Appends one event with sequence reservation and persistence in one commit. */
export async function insertChatThreadEventTransactionFixture(
  args: ChatThreadEventFixtureArgs,
): Promise<PersistedChatThreadEventFixture> {
  const eventId = randomUUID();
  const event = await db().transaction(async (tx) => {
    await appendChatThreadEvent(tx, {
      eventId,
      kind: "renamed",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: args.chatThreadId,
      agentComposeId: args.agentComposeId,
      title: args.title,
    });
    const [persisted] = await tx
      .select({ id: chatThreadEvents.id, seqId: chatThreadEvents.seqId })
      .from(chatThreadEvents)
      .where(eq(chatThreadEvents.id, eventId))
      .limit(1);
    return persisted;
  });
  if (!event) {
    throw new Error("Expected the chat-thread event insert");
  }
  return event;
}
