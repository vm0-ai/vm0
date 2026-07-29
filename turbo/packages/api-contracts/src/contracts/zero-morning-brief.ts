import { z } from "zod";

import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const triggerMorningBriefResponseSchema = z.object({
  runId: z.string().nullable(),
  briefDate: z.string(),
  queued: z.boolean(),
});

/**
 * Manual Morning Brief trigger for /api/zero/morning-brief/trigger
 *
 * Testing entry point gated by the manualMorningBrief feature switch:
 * immediately runs the collect → agent-run → email pipeline for the caller.
 */
export const zeroMorningBriefContract = c.router({
  trigger: {
    method: "POST",
    path: "/api/zero/morning-brief/trigger",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: triggerMorningBriefResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Trigger a morning brief immediately for the current user",
  },
});

export type ZeroMorningBriefContract = typeof zeroMorningBriefContract;
