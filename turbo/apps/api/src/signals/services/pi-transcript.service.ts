import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { piThreadMessages } from "@vm0/db/schema/pi-thread-message";
import { z } from "zod";

import type { AgentEvent } from "../../lib/event-consumer/verify";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import type { InsertAssistantEventsInput } from "./zero-chat-event-shared.service";
import type { ChatThreadEventTransaction } from "./zero-chat-thread-event.service";

export const PI_MESSAGE_COMPLETED_EVENT_TYPE = "pi.message.completed";

const MAX_PI_PAYLOAD_BYTES = 1_048_576;
export const PI_TRANSCRIPT_PAGE_SIZE = 10;

/**
 * Permanently rejected pi.message.completed deliveries. Retrying the same
 * payload cannot succeed, so the events webhook maps this to 400.
 */
export class PiTranscriptRejectedError extends Error {}

const piHandoffSchema = z
  .object({
    from: z.literal("api"),
    to: z.literal("sandbox"),
  })
  .strict();

const piMessageEventSchema = z
  .object({
    source: z.enum(["api", "sandbox"]),
    sequenceNumber: z.number().int().nonnegative(),
    messageId: z.string().min(1).max(255),
    message: z.object({ role: z.string().min(1).max(64) }).passthrough(),
    handoff: piHandoffSchema.optional(),
  })
  .superRefine((event, context) => {
    if (event.handoff === undefined) {
      return;
    }
    if (event.source !== "api") {
      context.addIssue({
        code: "custom",
        message: "Pi handoff events must originate from the API",
      });
    }
    if (event.message.role !== "assistant") {
      context.addIssue({
        code: "custom",
        message: "Pi handoff events must carry an assistant message",
      });
    }
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

/** Append completed Pi messages while holding the per-thread transcript lock. */
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
  const version = headRow?.version ?? 1;
  let nextOrdinal = (headRow?.ordinal ?? 0) + 1;
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
    rowsToInsert.push({
      chatThreadId: args.chatThreadId,
      version,
      ordinal: nextOrdinal,
      runId: args.runId,
      runEventSequenceNumber: event.sequenceNumber,
      messageId: event.messageId,
      role: event.message.role,
      payload: event.message,
      payloadHash,
      createdAt: appendedAt,
    });
    nextOrdinal += 1;
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
  readonly lastOrdinal: number;
  readonly hasMore: boolean;
  readonly messages: readonly PiTranscriptMessage[];
}

export async function readPiTranscript(
  db: Pick<Db, "select">,
  chatThreadId: string,
  afterOrdinal = 0,
  limit?: number,
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
    return { lastOrdinal: afterOrdinal, hasMore: false, messages: [] };
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
        gt(piThreadMessages.ordinal, afterOrdinal),
        lte(piThreadMessages.ordinal, headRow.ordinal),
      ),
    )
    .orderBy(asc(piThreadMessages.ordinal))
    .limit(limit ?? headRow.ordinal);
  const lastOrdinal = rows.at(-1)?.ordinal ?? afterOrdinal;
  return {
    lastOrdinal,
    hasMore: lastOrdinal < headRow.ordinal,
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
    source: event.source,
    sequenceNumber: event.sequenceNumber,
    messageId: event.messageId,
    ...(event.handoff === undefined ? {} : { handoff: event.handoff }),
    role: message?.role,
    payloadBytes:
      message === null
        ? undefined
        : Buffer.byteLength(JSON.stringify(message), "utf8"),
  };
}
