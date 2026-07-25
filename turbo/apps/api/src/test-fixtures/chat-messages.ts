import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { and, count, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "../signals/services/crypto.utils";
import { insertChatMessage } from "../signals/services/zero-chat-message.service";
import { createDeferredPromise } from "../signals/utils";

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
const WORKFLOW_QUEUE_EVENT_PARAMS_KEY = "__workflow_queue_event_params__";
const previousWorkflowQueueEventParamsSchema = z.object({
  version: z.literal(1),
  prompt: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  callbacks: z.array(z.unknown()).optional(),
  recordLastRunId: z.boolean().optional(),
  recordLastRunAt: z.boolean().optional(),
});

/**
 * Move one exact workflow event into historical state without waiting for real
 * time to pass. Product APIs cannot construct an already-stale queue item.
 */
export async function setWorkflowQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(chatMessageQueue)
    .set({ createdAt: args.createdAt })
    .where(
      and(
        eq(chatMessageQueue.id, args.eventId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    )
    .returning({ id: chatMessageQueue.id });
  if (updated.length !== 1) {
    throw new Error("Expected one workflow queue event to become historical");
  }
}

/**
 * Rewrites one current workflow event to the persisted shape and automation
 * state produced by the previous API version.
 *
 * Why product APIs cannot construct this state: the current writer always
 * includes its new v1 fields and keeps a claimed one-time automation enabled
 * until final run claim. This fixture is limited to one exact queue event and
 * one exact one-time automation so the cross-version reader path can be tested.
 */
export async function rewriteWorkflowQueueEventAsPreviousVersionFixture(args: {
  readonly eventId: string;
  readonly automationId: string;
}): Promise<void> {
  const [event] = await db()
    .select({
      orgId: chatMessageQueue.orgId,
      userId: chatMessageQueue.userId,
      encryptedParams: chatMessageQueue.encryptedParams,
    })
    .from(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.id, args.eventId),
        eq(chatMessageQueue.automationId, args.automationId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    )
    .limit(1);
  if (!event?.encryptedParams) {
    throw new Error("Expected a persisted workflow queue event");
  }

  const ctx = { orgId: event.orgId, userId: event.userId };
  const decrypted = await decryptPersistentSecretsMap(
    event.encryptedParams,
    ctx,
  );
  const raw = decrypted?.[WORKFLOW_QUEUE_EVENT_PARAMS_KEY];
  if (!raw) {
    throw new Error("Expected workflow queue event params");
  }
  const previousParams = previousWorkflowQueueEventParamsSchema.parse(
    JSON.parse(raw) as unknown,
  );
  const encryptedParams = await encryptPersistentSecretsMap(
    { [WORKFLOW_QUEUE_EVENT_PARAMS_KEY]: JSON.stringify(previousParams) },
    ctx,
  );
  if (!encryptedParams) {
    throw new Error("Failed to encrypt previous workflow queue event params");
  }

  await db().transaction(async (tx) => {
    const rewritten = await tx
      .update(chatMessageQueue)
      .set({ encryptedParams })
      .where(
        and(
          eq(chatMessageQueue.id, args.eventId),
          eq(chatMessageQueue.automationId, args.automationId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .returning({ id: chatMessageQueue.id });
    const disabled = await tx
      .update(zeroWorkflowAutomations)
      .set({ enabled: false })
      .where(
        and(
          eq(zeroWorkflowAutomations.id, args.automationId),
          eq(zeroWorkflowAutomations.kind, "schedule"),
          eq(zeroWorkflowAutomations.scheduleType, "once"),
        ),
      )
      .returning({ id: zeroWorkflowAutomations.id });
    if (rewritten.length !== 1 || disabled.length !== 1) {
      throw new Error("Failed to reproduce previous workflow queue state");
    }
  });
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
 * Holds one queued user-message row so a claim and recall can reach the same
 * product lock in a test-owned order. This timing-only boundary neither creates
 * nor changes product rows and cannot block unrelated queue items.
 */
export async function holdChatMessageQueueItemFixture(args: {
  readonly threadId: string;
  readonly messageId: string;
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
    const rows = await tx
      .select({ id: chatMessageQueue.id })
      .from(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.chatThreadId, args.threadId),
          eq(chatMessageQueue.chatMessageId, args.messageId),
          eq(chatMessageQueue.itemType, "user_message"),
        ),
      )
      .for("update")
      .limit(1);
    if (!rows[0]) {
      throw new Error("Expected the queued chat message row");
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
 * Holds one existing chat-message row so thread deletion can pause after it
 * owns the parent thread lock. This timing-only boundary does not create or
 * mutate product data and cannot block messages outside the selected thread.
 */
export async function holdChatMessageFixture(args: {
  readonly threadId: string;
  readonly messageId: string;
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
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, args.messageId),
          eq(chatMessages.chatThreadId, args.threadId),
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
 * Inserts one message through the production sequence writer, then holds its
 * transaction open. No product endpoint can pause between INSERT and COMMIT,
 * so this fixture is the narrow timing boundary for sequence serialization.
 */
export async function holdChatMessageInsertTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly message: { readonly id: string; readonly seqId: number };
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly message: { readonly id: string; readonly seqId: number };
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
    const message = await insertChatMessage(tx, {
      chatThreadId: args.threadId,
      role: "assistant",
      content: args.content,
      runId: null,
    });
    if (!message) {
      throw new Error("Expected the held chat-message insert");
    }
    started.resolve({ pid: holderPid, message });
    await released.promise;
  });
  const { pid, message } = await started.promise;

  return {
    message,
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

/** Inserts one message with reservation and persistence in one transaction. */
export async function insertChatMessageTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const message = await db().transaction(async (tx) => {
    return await insertChatMessage(tx, {
      chatThreadId: args.threadId,
      role: "assistant",
      content: args.content,
      runId: null,
    });
  });
  if (!message) {
    throw new Error("Expected the chat-message insert");
  }
  return message;
}
