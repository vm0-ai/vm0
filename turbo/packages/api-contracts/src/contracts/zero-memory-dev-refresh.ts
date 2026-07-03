import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const memoryDevRefreshSkippedResponseSchema = z.object({
  skipped: z.literal(true),
});

const memoryDevRefreshSummarizedResponseSchema = z.object({
  summarized: z.number(),
});

export const memoryDevRefreshResponseSchema = z.union([
  memoryDevRefreshSkippedResponseSchema,
  memoryDevRefreshSummarizedResponseSchema,
]);

export type MemoryDevRefreshResponse = z.infer<
  typeof memoryDevRefreshResponseSchema
>;

/**
 * Staff/development-only refresh endpoint for iterating on Memory Activity
 * summary generation against the current user's memory artifact.
 */
export const zeroMemoryDevRefreshContract = c.router({
  refresh: {
    method: "POST",
    path: "/api/zero/memory/dev-refresh",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: memoryDevRefreshResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Force-refresh memory summaries for the current user",
  },
});

export type ZeroMemoryDevRefreshContract = typeof zeroMemoryDevRefreshContract;
