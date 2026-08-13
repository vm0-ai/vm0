import { z } from "zod";
import { chatEventTypeSchema } from "./chat-events";

const requiredJsonValueSchema = z.unknown().refine((value) => {
  return value !== undefined;
}, "Expected a JSON value");

/** Canonical payload envelope for one raw chat-event row. */
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
 * One canonical chat_events row and the strict outer wire shape emitted by
 * the Snapshot and Raw Event endpoints. Version-specific payload projection is
 * selected by X-Chat-Event-Schema-Version.
 */
export const chatEventRowSchema = z
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

export type ChatEventRow = z.infer<typeof chatEventRowSchema>;
