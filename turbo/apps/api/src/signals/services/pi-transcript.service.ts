import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { piThreadMessages } from "@vm0/db/schema/pi-thread-message";
import { z } from "zod";

import type { AgentEvent } from "../../lib/event-consumer/verify";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import type { InsertAssistantEventsInput } from "./zero-chat-event-shared.service";
import type { ChatThreadEventTransaction } from "./zero-chat-thread-event.service";

export const PI_MESSAGE_COMPLETED_EVENT_TYPE = "pi.message.completed";

const MAX_PI_PAYLOAD_BYTES = 1_048_576;

/**
 * Permanently rejected pi.message.completed deliveries. Retrying the same
 * payload cannot succeed, so the events webhook maps this to 400.
 */
export class PiTranscriptRejectedError extends Error {}

/**
 * Transcript tail moved or a message id was reused with different content.
 * The sender must re-read the transcript before appending again; the events
 * webhook maps this to 409.
 */
export class PiTranscriptConflictError extends Error {}

const piMessageEventSchema = z.object({
  sequenceNumber: z.number().int().nonnegative(),
  messageId: z.string().min(1).max(255),
  expectedVersion: z.number().int().min(1),
  expectedLastOrdinal: z.number().int().nonnegative(),
  message: z.object({ role: z.string().min(1).max(64) }).passthrough(),
});

type PiMessageEvent = z.infer<typeof piMessageEventSchema>;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function piMessageEventsFromEvents(
  events: readonly AgentEvent[],
): PiMessageEvent[] {
  const piEvents: PiMessageEvent[] = [];
  for (const event of events) {
    if (event.type !== PI_MESSAGE_COMPLETED_EVENT_TYPE) {
      continue;
    }
    const parsed = piMessageEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new PiTranscriptRejectedError(
        `Invalid ${PI_MESSAGE_COMPLETED_EVENT_TYPE} event at sequence ${event.sequenceNumber}`,
      );
    }
    piEvents.push(parsed.data);
  }
  return piEvents.sort((left, right) => {
    return left.sequenceNumber - right.sequenceNumber;
  });
}

function piAssistantText(message: PiMessageEvent["message"]): string | null {
  if (message.role !== "assistant") {
    return null;
  }
  const content = message.content;
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
  return parts.join("\n\n");
}

/**
 * Appends pi.message.completed deliveries to the thread transcript with a
 * tail compare-and-swap. Deliveries whose message id already exists with the
 * same content at the same position are treated as replays; their assistant
 * items are still returned so a retried delivery repairs any missing chat
 * event projection (insertion dedups on the deterministic event id).
 *
 * Callers must hold the per-thread pi transcript advisory lock.
 */
async function appendPiMessagesInTransaction(
  tx: ChatThreadEventTransaction,
  args: {
    readonly runId: string;
    readonly chatThreadId: string;
    readonly events: readonly PiMessageEvent[];
  },
): Promise<InsertAssistantEventsInput["items"]> {
  const [headRow] = await tx
    .select({
      version: piThreadMessages.version,
      ordinal: piThreadMessages.ordinal,
    })
    .from(piThreadMessages)
    .where(eq(piThreadMessages.chatThreadId, args.chatThreadId))
    .orderBy(desc(piThreadMessages.version), desc(piThreadMessages.ordinal))
    .limit(1);
  const existingRows = await tx
    .select({
      messageId: piThreadMessages.messageId,
      version: piThreadMessages.version,
      ordinal: piThreadMessages.ordinal,
      runId: piThreadMessages.runId,
      payloadHash: piThreadMessages.payloadHash,
    })
    .from(piThreadMessages)
    .where(
      and(
        eq(piThreadMessages.chatThreadId, args.chatThreadId),
        inArray(
          piThreadMessages.messageId,
          args.events.map((event) => {
            return event.messageId;
          }),
        ),
      ),
    );
  const existingByMessageId = new Map(
    existingRows.map((row) => {
      return [row.messageId, row] as const;
    }),
  );

  let head = headRow ?? { version: 1, ordinal: 0 };
  const assistantItems: {
    readonly runEventSequenceNumber: number;
    readonly content: string;
    readonly runEventId: string;
  }[] = [];
  const rowsToInsert: (typeof piThreadMessages.$inferInsert)[] = [];
  const appendedAt = nowDate();
  for (const event of args.events) {
    const payloadJson = JSON.stringify(event.message);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PI_PAYLOAD_BYTES) {
      throw new PiTranscriptRejectedError(
        `Pi message ${event.messageId} payload exceeds ${MAX_PI_PAYLOAD_BYTES} bytes`,
      );
    }
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
    const existing = existingByMessageId.get(event.messageId);
    if (existing) {
      const replayed =
        existing.payloadHash === payloadHash &&
        existing.runId === args.runId &&
        existing.version === event.expectedVersion &&
        existing.ordinal === event.expectedLastOrdinal + 1;
      if (!replayed) {
        throw new PiTranscriptConflictError(
          `Pi message ${event.messageId} conflicts with an existing transcript message`,
        );
      }
    } else {
      if (
        head.version !== event.expectedVersion ||
        head.ordinal !== event.expectedLastOrdinal
      ) {
        throw new PiTranscriptConflictError(
          `Transcript tail is at ${head.version}/${head.ordinal}, delivery expected ${event.expectedVersion}/${event.expectedLastOrdinal}`,
        );
      }
      rowsToInsert.push({
        chatThreadId: args.chatThreadId,
        version: event.expectedVersion,
        ordinal: event.expectedLastOrdinal + 1,
        runId: args.runId,
        runEventSequenceNumber: event.sequenceNumber,
        messageId: event.messageId,
        role: event.message.role,
        payload: event.message,
        payloadHash,
        createdAt: appendedAt,
      });
      head = { version: event.expectedVersion, ordinal: head.ordinal + 1 };
    }
    const text = piAssistantText(event.message);
    if (text !== null) {
      assistantItems.push({
        runEventSequenceNumber: event.sequenceNumber,
        content: text,
        runEventId: event.messageId,
      });
    }
  }
  if (rowsToInsert.length > 0) {
    await tx.insert(piThreadMessages).values(rowsToInsert);
  }
  return assistantItems;
}

/**
 * Required projection for pi.message.completed deliveries: serializes on the
 * thread transcript advisory lock, appends the transcript rows, and returns
 * the assistant items to project as output.message chat events in the same
 * transaction.
 */
export async function projectPiEventsInTransaction(
  tx: ChatThreadEventTransaction,
  args: {
    readonly runId: string;
    readonly thread: { readonly chatThreadId: string } | null;
    readonly events: readonly AgentEvent[];
  },
  signal: AbortSignal,
): Promise<InsertAssistantEventsInput["items"]> {
  const piEvents = piMessageEventsFromEvents(args.events);
  if (piEvents.length === 0) {
    return [];
  }
  if (!args.thread) {
    throw new PiTranscriptRejectedError(
      "Pi messages require a run bound to a chat thread",
    );
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pi_transcript:${args.thread.chatThreadId}`}, 0))`,
  );
  signal.throwIfAborted();
  const items = await appendPiMessagesInTransaction(tx, {
    runId: args.runId,
    chatThreadId: args.thread.chatThreadId,
    events: piEvents,
  });
  signal.throwIfAborted();
  return items;
}

interface PiTranscriptMessage {
  readonly ordinal: number;
  readonly messageId: string;
  readonly runId: string;
  readonly runEventSequenceNumber: number;
  readonly role: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

interface PiTranscript {
  readonly version: number;
  readonly lastOrdinal: number;
  readonly messages: readonly PiTranscriptMessage[];
}

export async function readPiTranscript(
  db: Pick<Db, "select">,
  chatThreadId: string,
): Promise<PiTranscript> {
  const [headRow] = await db
    .select({
      version: piThreadMessages.version,
      ordinal: piThreadMessages.ordinal,
    })
    .from(piThreadMessages)
    .where(eq(piThreadMessages.chatThreadId, chatThreadId))
    .orderBy(desc(piThreadMessages.version), desc(piThreadMessages.ordinal))
    .limit(1);
  if (!headRow) {
    return { version: 1, lastOrdinal: 0, messages: [] };
  }
  const rows = await db
    .select({
      ordinal: piThreadMessages.ordinal,
      messageId: piThreadMessages.messageId,
      runId: piThreadMessages.runId,
      runEventSequenceNumber: piThreadMessages.runEventSequenceNumber,
      role: piThreadMessages.role,
      payload: piThreadMessages.payload,
      createdAt: piThreadMessages.createdAt,
    })
    .from(piThreadMessages)
    .where(
      and(
        eq(piThreadMessages.chatThreadId, chatThreadId),
        eq(piThreadMessages.version, headRow.version),
      ),
    )
    .orderBy(asc(piThreadMessages.ordinal));
  return {
    version: headRow.version,
    lastOrdinal: headRow.ordinal,
    messages: rows.map((row): PiTranscriptMessage => {
      return {
        ordinal: row.ordinal,
        messageId: row.messageId,
        runId: row.runId,
        runEventSequenceNumber: row.runEventSequenceNumber,
        role: row.role,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Telemetry projection of a pi.message.completed event. The canonical message
 * payload is the model transcript and must not reach Axiom; only coordinates
 * and size metadata are ingested.
 */
export function redactPiEventForTelemetry(
  event: AgentEvent,
): Record<string, unknown> {
  const message = recordOf(event.message);
  return {
    type: event.type,
    sequenceNumber: event.sequenceNumber,
    messageId: event.messageId,
    expectedVersion: event.expectedVersion,
    expectedLastOrdinal: event.expectedLastOrdinal,
    role: message?.role,
    payloadBytes:
      message === null
        ? undefined
        : Buffer.byteLength(JSON.stringify(message), "utf8"),
  };
}
