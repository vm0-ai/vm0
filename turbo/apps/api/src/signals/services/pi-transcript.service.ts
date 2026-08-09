import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { piRunHandoffs } from "@vm0/db/schema/pi-run-handoff";
import { piThreadMessages } from "@vm0/db/schema/pi-thread-message";
import { isPiAgentMessage } from "@vm0/pi-agent-runtime/transcript";
import { z } from "zod";

import type { AgentEvent } from "../../lib/event-consumer/verify";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import type { InsertAssistantEventsInput } from "./zero-chat-event-shared.service";
import type { ChatThreadEventTransaction } from "./zero-chat-thread-event.service";

export const PI_MESSAGE_COMPLETED_EVENT_TYPE = "pi.message.completed";

const MAX_PI_PAYLOAD_BYTES = 1_048_576;

const piHandoffSchema = z
  .object({
    from: z.literal("api"),
    to: z.literal("sandbox"),
  })
  .strict();

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

const piMessageEventSchema = z
  .object({
    source: z.enum(["api", "sandbox"]),
    sequenceNumber: z.number().int().nonnegative(),
    messageId: z.string().min(1).max(255),
    expectedVersion: z.number().int().min(1),
    expectedLastOrdinal: z.number().int().nonnegative(),
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
type PiAssistantItem = InsertAssistantEventsInput["items"][number];

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
    if (!isPiAgentMessage(parsed.data.message)) {
      throw new PiTranscriptRejectedError(
        `Invalid Pi message payload at sequence ${event.sequenceNumber}`,
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

interface StoredPiRunHandoff {
  readonly transcriptVersion: number;
  readonly afterOrdinal: number;
  readonly messageId: string;
  readonly fromEnvironment: string;
  readonly toEnvironment: string;
}

async function existingPiRunHandoff(
  tx: ChatThreadEventTransaction,
  runId: string,
  events: readonly PiMessageEvent[],
  signal: AbortSignal,
): Promise<StoredPiRunHandoff | undefined> {
  if (
    !events.some((event) => {
      return event.handoff !== undefined;
    })
  ) {
    return undefined;
  }
  const [handoff] = await tx
    .select({
      transcriptVersion: piRunHandoffs.transcriptVersion,
      afterOrdinal: piRunHandoffs.afterOrdinal,
      messageId: piRunHandoffs.messageId,
      fromEnvironment: piRunHandoffs.fromEnvironment,
      toEnvironment: piRunHandoffs.toEnvironment,
    })
    .from(piRunHandoffs)
    .where(eq(piRunHandoffs.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return handoff;
}

function nextPiRunHandoff(args: {
  readonly runId: string;
  readonly event: PiMessageEvent;
  readonly existing: StoredPiRunHandoff | undefined;
  readonly pending: typeof piRunHandoffs.$inferInsert | undefined;
  readonly requestedAt: Date;
}): typeof piRunHandoffs.$inferInsert | undefined {
  const handoff = args.event.handoff;
  if (handoff === undefined) {
    return args.pending;
  }
  const afterOrdinal = args.event.expectedLastOrdinal + 1;
  if (args.existing) {
    const matches =
      args.existing.transcriptVersion === args.event.expectedVersion &&
      args.existing.afterOrdinal === afterOrdinal &&
      args.existing.messageId === args.event.messageId &&
      args.existing.fromEnvironment === handoff.from &&
      args.existing.toEnvironment === handoff.to;
    if (!matches) {
      throw new PiTranscriptConflictError(
        `Pi run ${args.runId} already has a different handoff boundary`,
      );
    }
    return args.pending;
  }
  if (args.pending !== undefined) {
    throw new PiTranscriptConflictError(
      `Pi run ${args.runId} has multiple handoff boundaries`,
    );
  }
  return {
    runId: args.runId,
    transcriptVersion: args.event.expectedVersion,
    afterOrdinal,
    messageId: args.event.messageId,
    fromEnvironment: handoff.from,
    toEnvironment: handoff.to,
    requestedAt: args.requestedAt,
  };
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
  signal: AbortSignal,
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
  signal.throwIfAborted();
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
  signal.throwIfAborted();
  const existingByMessageId = new Map(
    existingRows.map((row) => {
      return [row.messageId, row] as const;
    }),
  );
  const existingHandoff = await existingPiRunHandoff(
    tx,
    args.runId,
    args.events,
    signal,
  );
  signal.throwIfAborted();

  let head = headRow ?? { version: 1, ordinal: 0 };
  const assistantItems: PiAssistantItem[] = [];
  const rowsToInsert: (typeof piThreadMessages.$inferInsert)[] = [];
  let handoffToInsert: typeof piRunHandoffs.$inferInsert | undefined;
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
    handoffToInsert = nextPiRunHandoff({
      runId: args.runId,
      event,
      existing: existingHandoff,
      pending: handoffToInsert,
      requestedAt: appendedAt,
    });
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
    signal.throwIfAborted();
  }
  if (handoffToInsert !== undefined) {
    await tx.insert(piRunHandoffs).values(handoffToInsert);
    signal.throwIfAborted();
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
  const items = await appendPiMessagesInTransaction(
    tx,
    {
      runId: args.runId,
      chatThreadId: args.thread.chatThreadId,
      events: piEvents,
    },
    signal,
  );
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

interface PiRunHandoff {
  readonly runId: string;
  readonly from: "api";
  readonly to: "sandbox";
  readonly transcriptVersion: number;
  readonly afterOrdinal: number;
  readonly messageId: string;
  readonly requestedAt: string;
}

interface PiTranscript {
  readonly version: number;
  readonly lastOrdinal: number;
  readonly messages: readonly PiTranscriptMessage[];
  readonly handoff: PiRunHandoff | null;
}

export async function readPiTranscript(
  db: Pick<Db, "select">,
  chatThreadId: string,
  options: {
    readonly runId?: string;
    readonly version?: number;
    readonly afterOrdinal?: number;
  },
  signal: AbortSignal,
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
  signal.throwIfAborted();
  if (!headRow) {
    return { version: 1, lastOrdinal: 0, messages: [], handoff: null };
  }
  const messageConditions = [
    eq(piThreadMessages.chatThreadId, chatThreadId),
    eq(piThreadMessages.version, headRow.version),
    lte(piThreadMessages.ordinal, headRow.ordinal),
  ];
  if (
    options.version === headRow.version &&
    options.afterOrdinal !== undefined &&
    options.afterOrdinal <= headRow.ordinal
  ) {
    messageConditions.push(gt(piThreadMessages.ordinal, options.afterOrdinal));
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
    .where(and(...messageConditions))
    .orderBy(asc(piThreadMessages.ordinal));
  signal.throwIfAborted();
  const [handoffRow] = options.runId
    ? await db
        .select({
          runId: piRunHandoffs.runId,
          transcriptVersion: piRunHandoffs.transcriptVersion,
          afterOrdinal: piRunHandoffs.afterOrdinal,
          messageId: piRunHandoffs.messageId,
          fromEnvironment: piRunHandoffs.fromEnvironment,
          toEnvironment: piRunHandoffs.toEnvironment,
          requestedAt: piRunHandoffs.requestedAt,
        })
        .from(piRunHandoffs)
        .where(eq(piRunHandoffs.runId, options.runId))
        .limit(1)
    : [];
  signal.throwIfAborted();
  if (
    handoffRow &&
    (handoffRow.fromEnvironment !== "api" ||
      handoffRow.toEnvironment !== "sandbox")
  ) {
    throw new Error(`Pi run ${handoffRow.runId} has an invalid handoff route`);
  }
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
    handoff:
      handoffRow?.transcriptVersion === headRow.version &&
      handoffRow.afterOrdinal <= headRow.ordinal
        ? {
            runId: handoffRow.runId,
            from: "api",
            to: "sandbox",
            transcriptVersion: handoffRow.transcriptVersion,
            afterOrdinal: handoffRow.afterOrdinal,
            messageId: handoffRow.messageId,
            requestedAt: handoffRow.requestedAt.toISOString(),
          }
        : null,
  };
}
