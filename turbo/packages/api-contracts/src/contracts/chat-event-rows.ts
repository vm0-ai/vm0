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
