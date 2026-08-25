import { z } from "zod";
import { chatEventTypeSchema, outputToolPayloadSchema } from "./chat-events";

const requiredJsonValueSchema = z.unknown().refine((value) => {
  return value !== undefined;
}, "Expected a JSON value");

/** Canonical payload envelope for every pre-V6 raw chat-event row. */
const legacyChatEventRowPayloadSchema = z
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

const nonToolChatEventRowSchema = z
  .object({
    ...chatEventRowBaseShape,
    eventType: chatEventTypeSchema.exclude(["output.tool"]),
    payload: legacyChatEventRowPayloadSchema.nullable(),
  })
  .strict();

const outputToolChatEventRowSchema = z
  .object({
    ...chatEventRowBaseShape,
    eventType: z.literal("output.tool"),
    payload: outputToolPayloadSchema,
  })
  .strict();

/**
 * One canonical chat_events row and the strict outer wire shape emitted by
 * the Snapshot and Raw Event endpoints. Version-specific payload projection is
 * selected by X-Chat-Event-Schema-Version.
 */
export const chatEventRowSchema = z.discriminatedUnion("eventType", [
  nonToolChatEventRowSchema,
  outputToolChatEventRowSchema,
]);

export type ChatEventRow = z.infer<typeof chatEventRowSchema>;
