import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// A single chat thread's usage, aggregated across all its runs. Ordered by
// the most recent activity so the list reads as a chronological record.
const usageRecordChatRowSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
  // ISO string of the most recent usage event in this chat.
  lastActivityAt: z.string(),
});

const usageRecordResponseSchema = z.object({
  chats: z.array(usageRecordChatRowSchema),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  }),
});

export const zeroUsageRecordContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/usage/record",
    headers: authHeadersSchema,
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().positive().max(100).default(20),
    }),
    responses: {
      200: usageRecordResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Get the signed-in user's per-chat usage record, ordered by recent activity",
  },
});

export type ZeroUsageRecordContract = typeof zeroUsageRecordContract;
export type UsageRecordResponse = z.infer<typeof usageRecordResponseSchema>;
export type UsageRecordChatRow = z.infer<typeof usageRecordChatRowSchema>;
