import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const setCreditsRequestSchema = z.object({
  credits: z.number().int().min(0),
});

const setCreditsResponseSchema = z.object({
  credits: z.number(),
});

/**
 * Zero contract for POST /api/zero/debug/set-credits
 *
 * Sets the caller's active org credit balance to the requested value. Only
 * available outside of production. Used by the Debug settings panel to
 * preview credit-exhausted states (e.g. the insufficient-credits card) on
 * preview deployments.
 */
export const zeroDebugSetCreditsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/debug/set-credits",
    headers: authHeadersSchema,
    body: setCreditsRequestSchema,
    responses: {
      200: setCreditsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set credit balance for current org (non-production only)",
  },
});

export type ZeroDebugSetCreditsContract = typeof zeroDebugSetCreditsContract;
