import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { and, count, eq, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { nowDate } from "../lib/time";
import { insertChatEvent } from "../signals/services/zero-chat-event.service";
import { createDeferredPromise, onRejection } from "../signals/utils";

/**
 * BDD-scoped vm0 managed key prefixes. Fixture writes below only ever touch
 * rows whose api_key carries one of these prefixes, so concurrent test files
 * cannot clobber real seed data or each other's non-bdd rows.
 */
const VM0_BDD_API_KEY_PREFIXES = [
  "vm0-key-bdd-fake-",
  "vm0-key-bdd-dev-seed-",
] as const;
const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });
const blockedByPidRowSchema = z.object({ blocked: z.boolean() });

/**
 * Move one exact workflow event into historical state without waiting for real
 * time to pass. Product APIs cannot construct an already-stale queue item.
 */
export async function setWorkflowQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.automation"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one workflow queue event to become historical");
  }
}

/**
 * Move one exact queued web message into historical state without waiting for
 * real time to pass. Product APIs cannot construct an already-stale queue item.
 */
export async function setQueuedUserMessageCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one queued user message to become historical");
  }
}

/**
 * Complete one claimed run without dispatching its terminal callbacks. This
 * reproduces the missed-callback state that the stale queue sweep recovers.
 */
export async function completeRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const completedAt = nowDate();
  const updated = await db()
    .update(agentRuns)
    .set({ status: "completed", completedAt })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to complete without callbacks");
  }
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

async function directBlockedWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

async function pidIsBlocked(waiterPid: number): Promise<boolean> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT cardinality(pg_blocking_pids(${waiterPid})) > 0 AS "blocked"
    `,
    blockedByPidRowSchema,
  );
  return rows[0]?.blocked ?? false;
}

function bddVm0ApiKeyFilter(vendor: string, model: string) {
  const [fakePrefix, devSeedPrefix] = VM0_BDD_API_KEY_PREFIXES;
  return and(
    eq(vm0ApiKeys.vendor, vendor),
    eq(vm0ApiKeys.model, model),
    or(
      like(vm0ApiKeys.apiKey, `${fakePrefix}%`),
      like(vm0ApiKeys.apiKey, `${devSeedPrefix}%`),
    ),
  );
}

/**
 * Replaces the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model.
 *
 * Why product APIs cannot construct this state: vm0_api_keys is a
 * platform-operations table with no product write surface — keys are
 * provisioned out of band. Keys passed here must carry a
 * VM0_BDD_API_KEY_PREFIXES prefix so only bdd rows are touched.
 */
export async function replaceBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
  readonly keys: readonly { readonly apiKey: string; readonly label: string }[];
}): Promise<void> {
  for (const key of args.keys) {
    const scoped = VM0_BDD_API_KEY_PREFIXES.some((prefix) => {
      return key.apiKey.length > prefix.length && key.apiKey.startsWith(prefix);
    });
    if (!scoped) {
      throw new Error(
        `replaceBddVm0ApiKeys: api key must start with one of ${VM0_BDD_API_KEY_PREFIXES.join(", ")}`,
      );
    }
  }
  await db().transaction(async (tx) => {
    await tx
      .delete(vm0ApiKeys)
      .where(bddVm0ApiKeyFilter(args.vendor, args.model));
    if (args.keys.length > 0) {
      await tx.insert(vm0ApiKeys).values(
        args.keys.map((key) => {
          return {
            vendor: args.vendor,
            model: args.model,
            apiKey: key.apiKey,
            label: key.label,
          };
        }),
      );
    }
  });
}

/**
 * Deletes the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model. See replaceBddVm0ApiKeys for why no product API exists.
 */
export async function deleteBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
}): Promise<void> {
  await db()
    .delete(vm0ApiKeys)
    .where(bddVm0ApiKeyFilter(args.vendor, args.model));
}

/**
 * Checks the operator-managed label for a key returned through a public test
 * entry point. The key pool has no product read surface, and local dev seeds
 * may contain additional valid keys for the same vendor and model.
 */
export async function hasVm0ApiKeyLabel(args: {
  readonly vendor: string;
  readonly model: string;
  readonly apiKey: string;
  readonly label: string;
}): Promise<boolean> {
  const rows = await db()
    .select({ id: vm0ApiKeys.id })
    .from(vm0ApiKeys)
    .where(
      and(
        eq(vm0ApiKeys.vendor, args.vendor),
        eq(vm0ApiKeys.model, args.model),
        eq(vm0ApiKeys.apiKey, args.apiKey),
        eq(vm0ApiKeys.label, args.label),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

/**
 * Holds the production org admission advisory lock and reports its waiter
 * count. No product API exposes database lock timing, so this fixture is the
 * narrow boundary exception for the queue-drain concurrency test.
 */
export async function holdOrgAdmissionLockFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`
        SELECT
          pg_backend_pid() AS "pid",
          pg_advisory_xact_lock(hashtext(${args.orgId}))
      `,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the admission lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/**
 * Stages the canonical conversation clear inside an open transaction so a
 * concurrent run still resolves the pre-clear snapshot, then blocks on this
 * transaction when its launch commit re-reads the session row `FOR UPDATE`.
 *
 * Waiting on this transaction is a precise barrier for "the run captured its
 * snapshot and reached commit". Counting waiters on the org admission key is
 * not: the background queue drain takes that same key, so it can satisfy the
 * barrier before the run has resolved its session at all.
 */
export async function holdThreadSessionConversationClearFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .select({ agentSessionId: chatThreads.agentSessionId })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .limit(1);
    if (!thread?.agentSessionId) {
      throw new Error("Expected a bound chat thread session");
    }
    const [session] = await tx
      .update(agentSessions)
      .set({ conversationId: null })
      .where(eq(agentSessions.id, thread.agentSessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected a bound agent session");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the conversation clear holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'transactionid'
            AND NOT waiting.granted
            AND waiting.transactionid IN (
              SELECT held.transactionid
              FROM pg_locks AS held
              WHERE held.locktype = 'transactionid'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/**
 * Replaces one canonical binding with an otherwise valid session/run pair.
 * Product APIs cannot bind a thread to another owner's session, so this is the
 * narrow state boundary for ownership-corruption coverage.
 */
export async function replaceThreadSessionBindingFixture(args: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly runId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({
      agentSessionId: args.sessionId,
      agentSessionRunId: args.runId,
    })
    .where(eq(chatThreads.id, args.threadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread session binding to be replaced");
  }
}

/**
 * Stages a canonical binding clear after the queue-first message row is
 * visible. Starting this transaction earlier would block that row's parent FK
 * check; once the row exists, the uncommitted clear remains invisible to
 * resolution and blocks only final snapshot validation on the thread row.
 */
export async function holdThreadSessionBindingClearFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ agentSessionId: null, agentSessionRunId: null })
      .where(eq(chatThreads.id, args.threadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Expected a bound chat thread session");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the binding clear holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Deletes one completed run to reproduce retention cleanup of binding
 * provenance. No product endpoint exposes historical run deletion.
 */
export async function deleteAgentRunFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const deleted = await db()
    .delete(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .returning({ id: agentRuns.id });
  if (deleted.length !== 1) {
    throw new Error("Expected one agent run to be deleted");
  }
}

async function readBoundThreadSessionConversation(threadId: string): Promise<{
  readonly sessionId: string;
  readonly conversationId: string;
}> {
  const [boundSession] = await db()
    .select({
      id: agentSessions.id,
      conversationId: agentSessions.conversationId,
    })
    .from(chatThreads)
    .innerJoin(agentSessions, eq(agentSessions.id, chatThreads.agentSessionId))
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!boundSession?.conversationId) {
    throw new Error("Expected a bound chat thread conversation");
  }
  return {
    sessionId: boundSession.id,
    conversationId: boundSession.conversationId,
  };
}

async function holdThreadSessionConversationChangeStage(args: {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly index: number;
  readonly stageRequest: Promise<void>;
  readonly release: Promise<void>;
  readonly markQueued: (holderPid: number) => void;
  readonly markStaged: (holderPid: number) => void;
  readonly markReleased: (holderPid: number) => void;
}): Promise<void> {
  await args.stageRequest;
  const holderPid = await db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const pid = rows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the conversation change holder pid");
    }
    args.markQueued(pid);
    const [session] = await tx
      .update(agentSessions)
      .set({
        conversationId: args.index % 2 === 0 ? null : args.conversationId,
      })
      .where(eq(agentSessions.id, args.sessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected the bound agent session");
    }
    args.markStaged(pid);
    await args.release;
    return pid;
  });
  args.markReleased(holderPid);
}

async function waitForConversationChangeStages(
  stages: readonly Promise<void>[],
): Promise<void> {
  await Promise.all(stages);
}

/**
 * Alternates the bound session's conversation snapshot while consecutive run
 * preparations reach final admission. This is the timing boundary for proving
 * the retry limit without mocking the resolver or admission service.
 */
export async function holdThreadSessionConversationChangesFixture(args: {
  readonly threadId: string;
  readonly changeCount: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly queueNextChange: () => void;
  readonly release: () => void;
  readonly releaseAll: () => void;
  readonly done: Promise<void>;
  readonly stagedChangeCount: () => number;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly queuedChangeIsBlocked: () => Promise<boolean>;
}> {
  if (args.changeCount < 1) {
    throw new Error("Expected at least one conversation snapshot change");
  }
  const boundSession = await readBoundThreadSessionConversation(args.threadId);

  const firstStaged = createDeferredPromise<void>(args.signal);
  const releases = Array.from({ length: args.changeCount }, () => {
    return createDeferredPromise<void>(args.signal);
  });
  const stageRequests = Array.from({ length: args.changeCount }, () => {
    return createDeferredPromise<void>(args.signal);
  });
  const stagePids: (number | undefined)[] = Array.from({
    length: args.changeCount,
  });
  let currentHolderPid: number | null = null;
  let requestedChanges = 1;
  let lastQueuedIndex: number | null = null;
  let stagedChanges = 0;
  const firstStageRequest = stageRequests[0];
  if (!firstStageRequest) {
    throw new Error("Missing first conversation snapshot stage request");
  }
  firstStageRequest.resolve(undefined);
  const stages = stageRequests.map(async (stageRequest, index) => {
    const release = releases[index];
    if (!release) {
      throw new Error("Missing conversation snapshot release gate");
    }
    await holdThreadSessionConversationChangeStage({
      sessionId: boundSession.sessionId,
      conversationId: boundSession.conversationId,
      index,
      stageRequest: stageRequest.promise,
      release: release.promise,
      markQueued: (holderPid) => {
        stagePids[index] = holderPid;
      },
      markStaged: (holderPid) => {
        currentHolderPid = holderPid;
        stagedChanges = index + 1;
        if (!firstStaged.settled()) {
          firstStaged.resolve(undefined);
        }
      },
      markReleased: (holderPid) => {
        if (currentHolderPid === holderPid) {
          currentHolderPid = null;
        }
      },
    });
  });
  const done = onRejection(waitForConversationChangeStages(stages), (error) => {
    if (!firstStaged.settled()) {
      firstStaged.reject(error);
    }
  });
  await firstStaged.promise;

  return {
    queueNextChange: () => {
      const stageRequest = stageRequests[requestedChanges];
      if (!stageRequest) {
        throw new Error("No remaining conversation snapshot change to queue");
      }
      lastQueuedIndex = requestedChanges;
      requestedChanges += 1;
      stageRequest.resolve(undefined);
    },
    release: () => {
      const release = releases[stagedChanges - 1];
      if (release && !release.settled()) {
        release.resolve(undefined);
      }
    },
    releaseAll: () => {
      for (const stageRequest of stageRequests) {
        if (!stageRequest.settled()) {
          stageRequest.resolve(undefined);
        }
      }
      for (const release of releases) {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      }
    },
    done,
    stagedChangeCount: () => {
      return stagedChanges;
    },
    blockedWaiterCount: async () => {
      return currentHolderPid === null
        ? 0
        : await directBlockedWaiterCount(currentHolderPid);
    },
    queuedChangeIsBlocked: async () => {
      if (currentHolderPid === null || lastQueuedIndex === null) {
        return false;
      }
      const queuedPid = stagePids[lastQueuedIndex];
      if (!queuedPid || lastQueuedIndex < stagedChanges) {
        return false;
      }
      return await pidIsBlocked(queuedPid);
    },
  };
}

/**
 * Holds one pending chat input event so a claim and recall can reach the same
 * product lock in a test-owned order. This timing-only boundary neither creates
 * nor changes product rows and cannot block unrelated queue items.
 */
export async function holdChatEventQueueItemFixture(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly directBlockedWaiterCount: () => Promise<number>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .for("update")
      .limit(1);
    if (!pending) {
      throw new Error("Expected the pending chat input event");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message queue lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    directBlockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Holds one existing ChatEvent row so thread deletion can pause after it
 * owns the parent thread lock. This timing-only boundary does not create or
 * mutate product data and cannot block messages outside the selected thread.
 */
export async function holdChatEventFixture(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
        ),
      )
      .for("update")
      .limit(1);
    if (!rows[0]) {
      throw new Error("Expected the chat message row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Inserts one event through the production sequence writer, then holds its
 * transaction open. No product endpoint can pause between INSERT and COMMIT,
 * so this fixture is the narrow timing boundary for sequence serialization.
 */
export async function holdChatEventInsertTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly event: { readonly id: string; readonly seqId: number };
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly event: { readonly id: string; readonly seqId: number };
  }>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
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
      throw new Error("Expected the chat-message insert holder pid");
    }
    const event = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: args.content,
      runId: null,
    });
    if (!event) {
      throw new Error("Expected the held chat-message insert");
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

/** Inserts one event with reservation and persistence in one transaction. */
export async function insertChatEventTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const event = await db().transaction(async (tx) => {
    return await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: args.content,
      runId: null,
    });
  });
  if (!event) {
    throw new Error("Expected the chat-message insert");
  }
  return event;
}

/**
 * Appends an explicit output event with a nullable compatibility payload owned
 * by a different ChatEvent leaf. Product writers intentionally
 * cannot create this divergent rollout shape; the fixture proves readers use
 * `event_type` as the semantic discriminator instead of legacy payload shape.
 */
export async function insertOutputEventWithConflictingLegacyPayloadFixture(args: {
  readonly threadId: string;
  readonly runId?: string;
  readonly content: string;
  readonly createdAt?: Date;
  readonly legacyPayload: "run.completed" | "usage.recorded";
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const event = await db().transaction(async (tx) => {
    const identity = {
      chatThreadId: args.threadId,
      eventType: "output.message" as const,
      content: args.content,
      runId: args.runId ?? null,
      createdAt: args.createdAt,
    };
    const lifecyclePayloadEvent = {
      ...identity,
      runLifecycleEvent: "completed",
    };
    const usagePayloadEvent = {
      ...identity,
      usagePayload: {
        version: 1 as const,
        totalCredits: 0,
        settledAt: (args.createdAt ?? nowDate()).toISOString(),
        breakdown: [],
      },
    };
    const inserted =
      args.legacyPayload === "run.completed"
        ? await insertChatEvent(tx, lifecyclePayloadEvent)
        : await insertChatEvent(tx, usagePayloadEvent);
    if (!inserted) {
      throw new Error("Expected the conflicting legacy-payload event insert");
    }
    return inserted;
  });
  return event;
}

/**
 * Appends the retired queue pause/resume marker rows exactly as the 0714
 * cutover backfill persisted them (reason in the error column). Product
 * writers intentionally cannot create these event types anymore; the fixture
 * proves the transcript read path serves the complete historical event stream
 * instead of skipping their seqIds.
 */
export async function insertRetiredQueuePauseEventsFixture(args: {
  readonly threadId: string;
  readonly pauseReason: string;
}): Promise<{ readonly pausedSeqId: number; readonly resumedSeqId: number }> {
  return await db().transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({
        lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + 2`,
      })
      .where(eq(chatThreads.id, args.threadId))
      .returning({ lastSeqId: chatThreads.lastChatEventSeqId });
    if (!thread) {
      throw new Error(`Chat thread ${args.threadId} not found`);
    }
    const pausedSeqId = thread.lastSeqId - 1;
    const resumedSeqId = thread.lastSeqId;
    const retiredEventType = (eventType: string) => {
      return eventType as (typeof chatEvents.$inferInsert)["eventType"];
    };
    await tx.insert(chatEvents).values([
      {
        chatThreadId: args.threadId,
        eventType: retiredEventType("queue.automation_paused"),
        error: args.pauseReason,
        seqId: pausedSeqId,
      },
      {
        chatThreadId: args.threadId,
        eventType: retiredEventType("queue.automation_resumed"),
        seqId: resumedSeqId,
      },
    ]);
    return { pausedSeqId, resumedSeqId };
  });
}
