import { z } from "zod";
import { chatEventTypeSchema } from "./chat-events";
import { runFailureReasonSchema } from "./run-failure-reasons";

const requiredJsonValueSchema = z.unknown().refine((value) => {
  return value !== undefined;
}, "Expected a JSON value");

/** Canonical payload envelope for a raw chat-event row. */
const chatEventRowPayloadSchema = z
  .object({
    content: z.string().optional(),
    userMessage: requiredJsonValueSchema.optional(),
    thinking: z.string().optional(),
    error: z.string().optional(),
    usage: requiredJsonValueSchema.optional(),
  })
  .strict();

const chatEventRowBaseShape = {
  id: z.string(),
  chatThreadId: z.string(),
  runId: z.string().nullable(),
  revokesEventId: z.string().nullable(),
  contextType: z.string().nullable(),
  contextId: z.string().nullable(),
  runEventSequenceNumber: z.number().int().nullable(),
  runEventId: z.string().nullable(),
  /** Strictly increasing within a thread; it may start above 1 and have gaps. */
  seqId: z.number().int(),
  createdAt: z.iso.datetime(),
};

/**
 * One canonical chat_events row and the strict output.tool-free outer wire
 * shape emitted by the Snapshot and Raw Event endpoints.
 */
export const chatEventRowV7Schema = z
  .object({
    ...chatEventRowBaseShape,
    eventType: chatEventTypeSchema,
    payload: chatEventRowPayloadSchema.nullable(),
  })
  .strict();

const chatEventRowV8FailedSchema = chatEventRowV7Schema
  .extend({
    eventType: z.literal("run.failed"),
    failureReason: runFailureReasonSchema.optional(),
  })
  .strict();

const chatEventRowV8OtherSchema = chatEventRowV7Schema
  .extend({
    eventType: chatEventTypeSchema.exclude(["run.failed"]),
    failureReason: z.never().optional(),
  })
  .strict();

export const chatEventRowSchema = z.union([
  chatEventRowV8FailedSchema,
  chatEventRowV8OtherSchema,
]);

export type ChatEventRow = z.infer<typeof chatEventRowSchema>;
export type ChatEventRowV7 = z.infer<typeof chatEventRowV7Schema>;

/** Exact adjacent-version downgrade used by V7 Raw Event and Snapshot reads. */
export function downgradeChatEventRowToV7(row: ChatEventRow): ChatEventRowV7 {
  const candidate: Record<string, unknown> = { ...row };
  delete candidate.failureReason;
  return chatEventRowV7Schema.parse(candidate);
}
