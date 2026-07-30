import { command } from "ccstate";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { runOutputMaterializations } from "@vm0/db/schema/run-output-materialization";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { nowDate } from "../../lib/time";
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
const RUN_OUTPUT_PROJECTION_LOCK_TIMEOUT = "1s";
const RUN_OUTPUT_PROJECTION_STATEMENT_TIMEOUT = "5s";

interface OutputCandidate {
  readonly sequenceNumber: number;
  readonly content: string;
}

export interface MaterializedChatProjection {
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

function assistantEventText(event: AgentEvent): string | null {
  return anthropicMessageText(event) ?? codexAgentMessageText(event);
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

function callbackOutputText(event: AgentEvent): string | null {
  return resultText(event) ?? codexAgentMessageText(event);
}

function latestCandidate(
  events: readonly AgentEvent[],
  extractText: (event: AgentEvent) => string | null,
): OutputCandidate | null {
  let latest: OutputCandidate | null = null;
  for (const event of events) {
    const content = extractText(event);
    if (content === null) {
      continue;
    }
    if (latest === null || event.sequenceNumber > latest.sequenceNumber) {
      latest = {
        sequenceNumber: event.sequenceNumber,
        content,
      };
    }
  }
  return latest;
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

function nextProjectionSequenceState(
  currentProcessedThroughSequence: number,
  currentPendingSequenceNumbers: readonly number[],
  events: readonly AgentEvent[],
): {
  readonly processedThroughSequence: number;
  readonly pendingSequenceNumbers: number[];
} {
  const sortedSequences = Array.from(
    new Set(
      [
        ...currentPendingSequenceNumbers,
        ...events.map((event) => {
          return event.sequenceNumber;
        }),
      ].filter((sequenceNumber) => {
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

  return {
    processedThroughSequence: nextProcessedThroughSequence,
    pendingSequenceNumbers: sortedSequences.filter((sequenceNumber) => {
      return sequenceNumber > nextProcessedThroughSequence;
    }),
  };
}

function nextStoredProjectionSequenceState(
  current:
    | {
        readonly processedThroughSequence: number;
        readonly pendingSequenceNumbers: readonly number[];
      }
    | undefined,
  events: readonly AgentEvent[],
): {
  readonly processedThroughSequence: number;
  readonly pendingSequenceNumbers: number[];
} {
  return nextProjectionSequenceState(
    current?.processedThroughSequence ?? INITIAL_PROCESSED_THROUGH_SEQUENCE,
    current?.pendingSequenceNumbers ?? [],
    events,
  );
}

function assistantEventItems(
  events: readonly AgentEvent[],
): InsertAssistantEventsInput["items"] {
  return events.flatMap((event) => {
    const text = assistantEventText(event);
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

async function materializeRunOutputEvents(
  writeDb: Db,
  payload: EventConsumerPayload,
  signal: AbortSignal,
): Promise<MaterializedChatProjection | null> {
  const assistantItems = assistantEventItems(payload.events);
  const latestResult = latestCandidate(payload.events, resultText);
  const latestOutput = latestCandidate(payload.events, callbackOutputText);
  const projectionLockKey = `run_output_projection:${payload.runId}`;

  return await writeDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${RUN_OUTPUT_PROJECTION_LOCK_TIMEOUT}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${RUN_OUTPUT_PROJECTION_STATEMENT_TIMEOUT}, true)`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectionLockKey}, 0))`,
    );
    signal.throwIfAborted();

    const thread = await chatThreadForRunFromDb(tx, payload.runId);
    signal.throwIfAborted();

    let insertedRowCount = 0;
    let shouldAttemptFirstAssistantEventClaim = false;
    if (thread) {
      const insertion = await insertAssistantEventsInTransaction(
        tx,
        {
          runId: payload.runId,
          threadId: thread.chatThreadId,
          userId: thread.userId,
          items: assistantItems,
        },
        signal,
      );
      insertedRowCount = insertion.insertedRowCount;
      shouldAttemptFirstAssistantEventClaim =
        insertion.shouldAttemptFirstAssistantEventClaim;
    }

    const [existingState] = await tx
      .select({
        processedThroughSequence:
          runOutputMaterializations.processedThroughSequence,
        pendingSequenceNumbers:
          runOutputMaterializations.pendingSequenceNumbers,
      })
      .from(runOutputMaterializations)
      .where(eq(runOutputMaterializations.runId, payload.runId))
      .limit(1);
    signal.throwIfAborted();

    const { processedThroughSequence, pendingSequenceNumbers } =
      nextStoredProjectionSequenceState(existingState, payload.events);
    const updatedAt = nowDate();
    await tx
      .insert(runOutputMaterializations)
      .values({
        runId: payload.runId,
        processedThroughSequence,
        pendingSequenceNumbers,
        latestResultSequence: latestResult?.sequenceNumber,
        latestResultText: latestResult?.content,
        latestOutputSequence: latestOutput?.sequenceNumber,
        latestOutputText: latestOutput?.content,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: runOutputMaterializations.runId,
        set: {
          processedThroughSequence: sql`greatest(${runOutputMaterializations.processedThroughSequence}, ${processedThroughSequence})`,
          pendingSequenceNumbers,
          latestResultSequence:
            latestResult === null
              ? runOutputMaterializations.latestResultSequence
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.sequenceNumber} else ${runOutputMaterializations.latestResultSequence} end`,
          latestResultText:
            latestResult === null
              ? runOutputMaterializations.latestResultText
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.content} else ${runOutputMaterializations.latestResultText} end`,
          latestOutputSequence:
            latestOutput === null
              ? runOutputMaterializations.latestOutputSequence
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.sequenceNumber} else ${runOutputMaterializations.latestOutputSequence} end`,
          latestOutputText:
            latestOutput === null
              ? runOutputMaterializations.latestOutputText
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.content} else ${runOutputMaterializations.latestOutputText} end`,
          updatedAt,
        },
      });
    signal.throwIfAborted();

    if (!thread) {
      return null;
    }

    const acknowledgedAt = nowDate();
    const [firstAssistantClaim] =
      insertedRowCount > 0 && shouldAttemptFirstAssistantEventClaim
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
      insertedRowCount,
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

export const materializeRunOutputEvents$ = command(
  async (
    { set },
    payload: EventConsumerPayload,
    signal: AbortSignal,
  ): Promise<MaterializedChatProjection | null> => {
    return await materializeRunOutputEvents(set(writeDb$), payload, signal);
  },
);

export async function publishMaterializedChatProjection(
  payload: EventConsumerPayload,
  projection: MaterializedChatProjection,
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
