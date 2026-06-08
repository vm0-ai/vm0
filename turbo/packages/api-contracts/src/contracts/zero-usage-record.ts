import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Where a run originated. `chat` is web chat (trigger_source 'web'); known
// trigger sources keep their surface, and unsupported historical values are
// grouped as `other`.
export const usageRecordSourceSchema = z.enum([
  "chat",
  "schedule",
  "slack",
  "telegram",
  "email",
  "agentphone",
  "github",
  "cli",
  "agent",
  "other",
]);

export type UsageRecordSource = z.infer<typeof usageRecordSourceSchema>;

// One usage row. Threaded sources (chat, schedule) aggregate every run in the
// thread into a single row that links to the thread; unthreaded sources are one
// row per run that links to the run's activity detail. Ordered by most recent
// activity so the list reads as a chronological record.
const usageRecordRowSchema = z.object({
  source: usageRecordSourceSchema,
  // Set for threaded sources (web chat, schedule) — links to the chat thread.
  threadId: z.string().nullable(),
  // Set for unthreaded sources (slack, telegram, …) — links to the run.
  runId: z.string().nullable(),
  title: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
  // ISO string of the most recent run in this row.
  lastActivityAt: z.string(),
});

const usageRecordResponseSchema = z.object({
  rows: z.array(usageRecordRowSchema),
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
      source: usageRecordSourceSchema.optional(),
    }),
    responses: {
      200: usageRecordResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Get the signed-in user's usage record across sources, ordered by recent activity",
  },
});

export type ZeroUsageRecordContract = typeof zeroUsageRecordContract;
export type UsageRecordResponse = z.infer<typeof usageRecordResponseSchema>;
export type UsageRecordRow = z.infer<typeof usageRecordRowSchema>;
