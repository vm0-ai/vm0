import { z } from "zod";
import { chatEventTypeSchema } from "./chat-events";

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
export const chatEventRowSchema = z
  .object({
    ...chatEventRowBaseShape,
    eventType: chatEventTypeSchema,
    payload: chatEventRowPayloadSchema.nullable(),
  })
  .strict();

export type ChatEventRow = z.infer<typeof chatEventRowSchema>;
