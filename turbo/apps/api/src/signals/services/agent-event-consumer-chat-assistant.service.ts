import { command } from "ccstate";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { chatOutputMaterializations } from "@vm0/db/schema/chat-output-materialization";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { env } from "../../lib/env";
import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { onRejection } from "../utils";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import {
  insertAssistantEventsInTransaction,
  type InsertAssistantEventsInput,
} from "./zero-chat-event-shared.service";
import {
  publishFirstAssistantEventCreatedSignalSafely,
  recordFirstAssistantEventAcknowledgementMetric,
} from "./zero-chat-first-assistant-event-metric.service";
import { chatThreadForRunFromDb } from "./zero-chat-thread.service";

const INITIAL_PROCESSED_THROUGH_SEQUENCE = -1;
const CHAT_PROJECTION_LOCK_TIMEOUT = "1s";
const CHAT_PROJECTION_STATEMENT_TIMEOUT = "5s";

const L = logger("webhook:events:chat-projection");

class ChatProjectionAdmission {
  private active = 0;
  private readonly capacity = Math.max(1, Math.floor(env("DB_POOL_MAX") / 2));

  tryAcquire(): (() => void) | null {
    if (this.active >= this.capacity) {
      return null;
    }
    this.active += 1;
    return () => {
      this.active -= 1;
    };
  }
}

const chatProjectionAdmission = singleton(() => {
  return new ChatProjectionAdmission();
});

interface ChatProjection {
  readonly thread: {
    readonly chatThreadId: string;
    readonly userId: string;
  };
  readonly insertedRowCount: number;
  readonly firstAssistantAcknowledgement: {
    readonly apiStartedAt: number;
    readonly acknowledgedAt: number;
  } | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function anthropicMessageText(event: AgentEvent): string | null {
  if (event.type !== "assistant") {
    return null;
  }

  const message = recordOf(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = recordOf(block);
    if (
      record?.type === "text" &&
      typeof record.text === "string" &&
      record.text.trim().length > 0
    ) {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function codexAgentMessageText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (
    item?.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function eventText(event: AgentEvent): string | null {
  const fromMessage = anthropicMessageText(event);
  if (fromMessage !== null) {
    return fromMessage;
  }
  return codexAgentMessageText(event);
}

function resultText(event: AgentEvent): string | null {
  if (event.type !== "result") {
    return null;
  }

  const directResult = event.result;
  if (typeof directResult === "string" && directResult.trim().length > 0) {
    return directResult;
  }

  const eventData = recordOf(event.eventData);
  const nestedResult = eventData?.result;
  if (typeof nestedResult === "string" && nestedResult.trim().length > 0) {
    return nestedResult;
  }

  return null;
}

function eventMessageId(event: AgentEvent): string | undefined {
  const message = recordOf(event.message);
  if (typeof message?.id === "string") {
    return message.id;
  }

  const item = recordOf(event.item);
  if (typeof item?.id === "string") {
    return item.id;
  }

  return undefined;
}

function nextProcessedThroughSequence(
  currentProcessedThroughSequence: number,
  events: readonly AgentEvent[],
): number {
  const sortedSequences = Array.from(
    new Set(
      events
        .map((event) => {
          return event.sequenceNumber;
        })
        .filter((sequenceNumber) => {
          return Number.isInteger(sequenceNumber) && sequenceNumber >= 0;
        }),
    ),
  ).sort((left, right) => {
    return left - right;
  });

  let nextProcessedThroughSequence = currentProcessedThroughSequence;
  for (const sequenceNumber of sortedSequences) {
    if (sequenceNumber <= nextProcessedThroughSequence) {
      continue;
    }
    if (sequenceNumber !== nextProcessedThroughSequence + 1) {
      break;
    }
    nextProcessedThroughSequence = sequenceNumber;
  }

  return nextProcessedThroughSequence;
}

function latestResultSequence(events: readonly AgentEvent[]): number | null {
  let latestSequence: number | null = null;
  for (const event of events) {
    if (resultText(event) === null) {
      continue;
    }
    latestSequence =
      latestSequence === null
        ? event.sequenceNumber
        : Math.max(latestSequence, event.sequenceNumber);
  }
  return latestSequence;
}

function assistantEventItems(
  events: readonly AgentEvent[],
): InsertAssistantEventsInput["items"] {
  return events.flatMap((event) => {
    const text = eventText(event);
    if (text === null) {
      return [];
    }
    return [
      {
        sequenceNumber: event.sequenceNumber,
        content: text,
        runEventId: eventMessageId(event),
      },
    ];
  });
}

function projectChatAssistantEvents(
  writeDb: Db,
  payload: EventConsumerPayload,
  items: InsertAssistantEventsInput["items"],
  signal: AbortSignal,
): Promise<ChatProjection | null> {
  return writeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${CHAT_PROJECTION_LOCK_TIMEOUT}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${CHAT_PROJECTION_STATEMENT_TIMEOUT}, true)`,
    );
    signal.throwIfAborted();

    const thread = await chatThreadForRunFromDb(tx, payload.runId);
    signal.throwIfAborted();
    if (!thread) {
      return null;
    }

    const insertion = await insertAssistantEventsInTransaction(
      tx,
      {
        runId: payload.runId,
        threadId: thread.chatThreadId,
        userId: thread.userId,
        items,
      },
      signal,
    );
    const [existingState] = await tx
      .select({
        processedThroughSequence:
          chatOutputMaterializations.processedThroughSequence,
      })
      .from(chatOutputMaterializations)
      .where(eq(chatOutputMaterializations.runId, payload.runId))
      .limit(1);
    signal.throwIfAborted();

    const processedThroughSequence = nextProcessedThroughSequence(
      existingState?.processedThroughSequence ??
        INITIAL_PROCESSED_THROUGH_SEQUENCE,
      payload.events,
    );
    const resultSequence = latestResultSequence(payload.events);
    const updatedAt = nowDate();
    await tx
      .insert(chatOutputMaterializations)
      .values({
        runId: payload.runId,
        processedThroughSequence,
        latestResultSequence: resultSequence,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: chatOutputMaterializations.runId,
        set: {
          processedThroughSequence: sql`greatest(${chatOutputMaterializations.processedThroughSequence}, ${processedThroughSequence})`,
          latestResultSequence:
            resultSequence === null
              ? chatOutputMaterializations.latestResultSequence
              : sql`greatest(coalesce(${chatOutputMaterializations.latestResultSequence}, -1), ${resultSequence})`,
          updatedAt,
        },
      });
    signal.throwIfAborted();

    const acknowledgedAt = nowDate();
    const [firstAssistantClaim] =
      insertion.insertedRowCount > 0 &&
      insertion.shouldAttemptFirstAssistantEventClaim
        ? await tx
            .update(zeroRuns)
            .set({ firstAssistantEventAcknowledgedAt: acknowledgedAt })
            .where(
              and(
                eq(zeroRuns.id, payload.runId),
                isNotNull(zeroRuns.apiStartedAt),
                isNull(zeroRuns.firstAssistantEventAcknowledgedAt),
              ),
            )
            .returning({ apiStartedAt: zeroRuns.apiStartedAt })
        : [];
    signal.throwIfAborted();

    return {
      thread,
      insertedRowCount: insertion.insertedRowCount,
      firstAssistantAcknowledgement:
        firstAssistantClaim?.apiStartedAt === null ||
        firstAssistantClaim?.apiStartedAt === undefined
          ? null
          : {
              apiStartedAt: firstAssistantClaim.apiStartedAt.getTime(),
              acknowledgedAt: acknowledgedAt.getTime(),
            },
    };
  });
}

async function publishChatProjection(
  payload: EventConsumerPayload,
  projection: ChatProjection,
  signal: AbortSignal,
): Promise<void> {
  if (projection.insertedRowCount === 0) {
    return;
  }
  if (projection.firstAssistantAcknowledgement) {
    await publishFirstAssistantEventCreatedSignalSafely({
      userId: projection.thread.userId,
      threadId: projection.thread.chatThreadId,
      runId: payload.runId,
    });
    recordFirstAssistantEventAcknowledgementMetric({
      runId: payload.runId,
      ...projection.firstAssistantAcknowledgement,
    });
  } else {
    await publishChatThreadMessageCreatedSafely(
      projection.thread.userId,
      projection.thread.chatThreadId,
    );
  }
  signal.throwIfAborted();
  await publishThreadListChangedSafely(projection.thread.userId);
  signal.throwIfAborted();
}

async function runAdmittedChatProjection(
  writeDb: Db,
  payload: EventConsumerPayload,
  signal: AbortSignal,
  release: () => void,
) {
  const projection = await projectChatAssistantEvents(
    writeDb,
    payload,
    assistantEventItems(payload.events),
    signal,
  );
  signal.throwIfAborted();
  if (projection) {
    await publishChatProjection(payload, projection, signal);
    signal.throwIfAborted();
  }

  release();
  return {
    status: 200 as const,
    body: { processed: projection?.insertedRowCount ?? 0 },
  };
}

export const processChatAssistantEvents$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();
    const firstSequence = payload.events[0]!.sequenceNumber;
    const lastSequence =
      payload.events[payload.events.length - 1]!.sequenceNumber;
    const release = chatProjectionAdmission().tryAcquire();
    if (!release) {
      L.warn("Skipping live chat projection at the concurrency limit", {
        runId: payload.runId,
        firstSequence,
        lastSequence,
      });
      return { status: 200 as const, body: { processed: 0 } };
    }

    return await onRejection(
      runAdmittedChatProjection(set(writeDb$), payload, signal, release),
      release,
    );
  },
);
