import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Cleanup result schema
 */
const cleanupResultSchema = z.object({
  runId: z.string(),
  sandboxId: z.string().nullable(),
  status: z.enum(["cleaned", "error"]),
  error: z.string().optional(),
});

/**
 * Cleanup response schema
 */
const cleanupResponseSchema = z.object({
  cleaned: z.number(),
  errors: z.number(),
  results: z.array(cleanupResultSchema),
});

/**
 * Cron cleanup sandboxes contract for /api/cron/cleanup-sandboxes
 */
export const cronCleanupSandboxesContract = c.router({
  /**
   * GET /api/cron/cleanup-sandboxes
   * Cron job to cleanup sandboxes that have stopped sending heartbeats
   */
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-sandboxes",
    headers: authHeadersSchema,
    responses: {
      200: cleanupResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Cleanup expired sandboxes",
  },
});

export type CronCleanupSandboxesContract = typeof cronCleanupSandboxesContract;

// Export schemas for reuse
export { cleanupResultSchema, cleanupResponseSchema };
