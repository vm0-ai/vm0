import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Ably token request schema (matches Ably SDK's TokenRequest type)
 */
const ablyTokenRequestSchema = z.object({
  keyName: z.string(),
  ttl: z.number().optional(),
  timestamp: z.number(),
  capability: z.string(),
  clientId: z.string().optional(),
  nonce: z.string(),
  mac: z.string(),
});

/**
 * Realtime token contract for /api/realtime/token
 */
export const realtimeTokenContract = c.router({
  /**
   * POST /api/realtime/token
   * Get an Ably token to subscribe to a run's events channel
   */
  create: {
    method: "POST",
    path: "/api/realtime/token",
    headers: authHeadersSchema,
    body: z.object({
      runId: z.string().uuid("runId must be a valid UUID"),
    }),
    responses: {
      200: ablyTokenRequestSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get Ably token for run event subscription",
  },
});

export type RealtimeTokenContract = typeof realtimeTokenContract;

// Inferred types
export type AblyTokenRequest = z.infer<typeof ablyTokenRequestSchema>;
