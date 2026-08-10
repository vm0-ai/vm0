import { z } from "zod";
import { chatEventTypeSchema } from "./chat-events";

const requiredJsonValueSchema = z.unknown().refine((value) => {
  return value !== undefined;
}, "Expected a JSON value");

/**
 * One raw chat_events row, exactly as archived into R2 snapshot objects and
 * served by the /event-rows tail endpoint. This is the persisted wire shape
 * behind the snapshot-read pipeline: clients cache these rows verbatim and
 * project them into ChatEvent at the read boundary. The archiver's
 * ARCHIVE_SCHEMA_VERSION tracks this shape; changing it requires a version
 * bump there.
 */
export const chatEventRowSchema = z
  .object({
    id: z.string(),
    chatThreadId: z.string(),
    runId: z.string().nullable(),
    usagePayload: requiredJsonValueSchema,
    revokesEventId: z.string().nullable(),
    interruptsRunId: z.string().nullable(),
    runGroupId: z.string().nullable(),
    eventType: chatEventTypeSchema,
    contextType: z.string().nullable(),
    contextId: z.string().nullable(),
    content: z.string().nullable(),
    userMessage: requiredJsonValueSchema,
    thinking: z.string().nullable(),
    error: z.string().nullable(),
    runEventSequenceNumber: z.number().int().nullable(),
    runEventId: z.string().nullable(),
    seqId: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type ChatEventRow = z.infer<typeof chatEventRowSchema>;

/**
 * Canonical envelope for the legacy payload leaves. A key is present exactly
 * when its legacy column was non-null; nested JSON nulls inside userMessage
 * and usage are preserved verbatim.
 */
const chatEventRowPayloadSchema = z
  .object({
    content: z.string().optional(),
    userMessage: requiredJsonValueSchema.optional(),
    thinking: z.string().optional(),
    error: z.string().optional(),
    usage: requiredJsonValueSchema.optional(),
  })
  .strict();

/**
 * One canonical (v4) chat_events row: the internal model every reader
 * normalizes into, and the wire shape the archive/tail endpoints emit once
 * they leave v3. The legacy leaves live inside payload, control.interrupt
 * rows carry their target run in runId, and goal grouping is the
 * `goal` contextType with the goal id as contextId.
 */
export const chatEventRowV4Schema = z
  .object({
    id: z.string(),
    chatThreadId: z.string(),
    runId: z.string().nullable(),
    revokesEventId: z.string().nullable(),
    eventType: chatEventTypeSchema,
    payload: chatEventRowPayloadSchema.nullable(),
    contextType: z.string().nullable(),
    contextId: z.string().nullable(),
    runEventSequenceNumber: z.number().int().nullable(),
    runEventId: z.string().nullable(),
    seqId: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type ChatEventRowV4 = z.infer<typeof chatEventRowV4Schema>;
type ChatEventRowPayload = z.infer<typeof chatEventRowPayloadSchema>;

/**
 * Reader union over both persisted row generations. Both members are strict
 * and mutually exclusive: v3 rows carry the legacy leaf columns and never
 * `payload`, v4 rows carry `payload` and never the legacy leaves. Readers
 * must normalize every parsed row through canonicalChatEventRow before use.
 */
export const chatEventRowReadSchema = z.union([
  chatEventRowV4Schema,
  chatEventRowSchema,
]);

function canonicalChatEventRowPayload(
  row: ChatEventRow,
): ChatEventRowPayload | null {
  const { content, userMessage, thinking, error, usagePayload } = row;
  const payload: ChatEventRowPayload = {
    ...(content === null ? {} : { content }),
    ...(userMessage === null || userMessage === undefined
      ? {}
      : { userMessage }),
    ...(thinking === null ? {} : { thinking }),
    ...(error === null ? {} : { error }),
    ...(usagePayload === null || usagePayload === undefined
      ? {}
      : { usage: usagePayload }),
  };
  return Object.keys(payload).length === 0 ? null : payload;
}

/**
 * Normalize one raw row from either generation into the canonical model.
 * The v3 mapping mirrors the server-side backfill exactly: payload from every
 * non-null legacy leaf, interrupts_run_id as the canonical runId of a
 * control.interrupt row that has none, and the canonical
 * ('goal', runGroupId) pointer replacing any non-goal source tag on a
 * goal-grouped row, exactly as the dual-writer does. Only a goal pointer
 * naming a different goal id is preserved as-is.
 */
export function canonicalChatEventRow(
  row: ChatEventRow | ChatEventRowV4,
): ChatEventRowV4 {
  if ("payload" in row) {
    return row;
  }
  const goalContext =
    row.runGroupId !== null &&
    (row.contextType !== "goal" ||
      row.contextId === null ||
      row.contextId === row.runGroupId)
      ? { contextType: "goal", contextId: row.runGroupId }
      : { contextType: row.contextType, contextId: row.contextId };
  return {
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId:
      row.eventType === "control.interrupt" && row.runId === null
        ? row.interruptsRunId
        : row.runId,
    revokesEventId: row.revokesEventId,
    eventType: row.eventType,
    payload: canonicalChatEventRowPayload(row),
    ...goalContext,
    runEventSequenceNumber: row.runEventSequenceNumber,
    runEventId: row.runEventId,
    seqId: row.seqId,
    createdAt: row.createdAt,
  };
}
