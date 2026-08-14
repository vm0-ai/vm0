import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const queuePositionResponseSchema = z.object({
  position: z.number(),
  total: z.number(),
});

/**
 * Queue position contract (GET /api/okou/queue-position)
 * Returns the position of a queued run within its org queue.
 */
export const queuePositionContract = c.router({
  getPosition: {
    method: "GET",
    path: "/api/okou/queue-position",
    headers: authHeadersSchema,
    query: z.object({
      runId: z.string().min(1, "runId is required"),
    }),
    responses: {
      200: queuePositionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get queue position for a run",
  },
});

export type QueuePositionContract = typeof queuePositionContract;
