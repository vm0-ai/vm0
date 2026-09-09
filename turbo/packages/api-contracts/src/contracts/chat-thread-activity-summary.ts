import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const activitySummaryResponseSchema = z.object({
  runId: z.string().uuid(),
  phrase: z.string().nullable(),
  status: z.enum([
    "fresh",
    "stale",
    "pending",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
  sourceRevision: z.string().nullable(),
  summaryRevision: z.string().nullable(),
  sourceSequence: z.number().int().nullable(),
  summarySequence: z.number().int().nullable(),
  messageCursor: z.number().int().nonnegative(),
  summaryMessageCursor: z.number().int().nonnegative().nullable(),
  summarizedAt: z.string().datetime().nullable(),
  retryAfterMs: z.number().int().nonnegative(),
});
export type ActivitySummaryResponse = z.infer<
  typeof activitySummaryResponseSchema
>;

const c = initContract();
export const chatThreadActivitySummaryContract = c.router({
  summarize: {
    method: "POST",
    path: "/api/chat-threads/:id/activity-summary",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({ runId: z.string().uuid() }).strict(),
    responses: {
      200: activitySummaryResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Summarize current public run activity on demand",
  },
});
