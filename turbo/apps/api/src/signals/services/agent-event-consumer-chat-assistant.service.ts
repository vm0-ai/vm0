import { command } from "ccstate";
import { sql, eq } from "drizzle-orm";
import { chatOutputMaterializations } from "@vm0/db/schema/chat-output-materialization";

import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import type { AgentEvent } from "../../lib/event-consumer/verify";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  chatThreadForRun,
  insertAssistantEventMessages$,
} from "../services/zero-chat-thread.service";

const INITIAL_PROCESSED_THROUGH_SEQUENCE = -1;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function anthropicMessageText(event: AgentEvent): string | null {
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

export const processChatAssistantEvents$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    const items = payload.events.flatMap((event) => {
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

    const thread = await get(chatThreadForRun(payload.runId));
    signal.throwIfAborted();
    if (!thread) {
      return { status: 200 as const, body: { processed: 0 } };
    }

    const written =
      items.length === 0
        ? 0
        : await set(
            insertAssistantEventMessages$,
            {
              runId: payload.runId,
              threadId: thread.chatThreadId,
              userId: thread.userId,
              items,
            },
            signal,
          );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    const [existingState] = await writeDb
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

    await writeDb
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
          processedThroughSequence: sql<number>`greatest(${chatOutputMaterializations.processedThroughSequence}, ${processedThroughSequence})`,
          latestResultSequence:
            resultSequence === null
              ? chatOutputMaterializations.latestResultSequence
              : sql<number>`greatest(coalesce(${chatOutputMaterializations.latestResultSequence}, -1), ${resultSequence})`,
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return { status: 200 as const, body: { processed: written } };
  },
);
