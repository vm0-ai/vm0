import { createStore } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { env } from "../../lib/env";
import type { Db } from "../external/db";
import { readCurrentChatEventHistoryAtSnapshot } from "./chat-event-history.service";

/** Resolve archived provenance after a hot-row lookup, without Goal authority. */
export async function runEventHistory(
  db: Pick<Db, "select">,
  threadId: string,
  signal: AbortSignal,
): Promise<readonly ChatEventRow[]> {
  const head = async () => {
    const [row] = await db
      .select({
        objectKey: chatEventSnapshots.objectKey,
        lastSeqId: chatEventSnapshots.lastSeqId,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, threadId),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row;
  };
  // A usage writer holds its existing per-run advisory lock in READ COMMITTED.
  // Validate the immutable snapshot pointer across the read so concurrent
  // snapshot publication + hot retention cannot erase provenance between queries.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await head();
    if (before === undefined) {
      return [];
    }
    const events = await createStore().get(
      readCurrentChatEventHistoryAtSnapshot(
        { db, bucket: env("R2_USER_STORAGES_BUCKET_NAME") },
        threadId,
        signal,
      ),
    );
    const after = await head();
    if (
      before?.objectKey === after?.objectKey &&
      before?.lastSeqId === after?.lastSeqId
    ) {
      return events;
    }
  }
  throw new Error("Chat event history changed during provenance read");
}

export async function historicalRunGroupId(
  db: Pick<Db, "select">,
  runId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<string | undefined> {
  const [run] = await db
    .select({ threadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run?.threadId) {
    return undefined;
  }
  const hot = await db
    .select({
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      eventType: chatEvents.eventType,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        eq(chatEvents.chatThreadId, run.threadId),
      ),
    )
    .orderBy(asc(chatEvents.seqId));
  signal.throwIfAborted();
  const group = hot.find((event) => {
    return event.contextType === "goal";
  });
  if (group?.contextId) {
    return group.contextId;
  }
  // A retained prompt can coexist with archived output from the same run.
  // Its non-Goal context does not disprove a canonical archived Goal group.
  const history = await runEventHistory(db, run.threadId, signal);
  const original = history.find((event) => {
    return event.runId === runId && event.contextType === "goal";
  });
  // Absent provenance emits ungrouped generic accounting, never an invented group.
  return original?.contextId ?? undefined;
}
