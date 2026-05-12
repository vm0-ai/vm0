import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerGroupSchema } from "./runners";

const c = initContract();

/**
 * Ably token request schema (matches Ably SDK's TokenRequest type)
 */
export const ablyTokenRequestSchema = z.object({
  keyName: z.string(),
  ttl: z.number().optional(),
  timestamp: z.number(),
  capability: z.string(),
  clientId: z.string().optional(),
  nonce: z.string(),
  mac: z.string(),
});

/**
 * Runner realtime token contract for /api/runners/realtime/token
 */
export const runnerRealtimeTokenContract = c.router({
  /**
   * POST /api/runners/realtime/token
   * Get an Ably token to subscribe to a runner group's job notification channel
   */
  create: {
    method: "POST",
    path: "/api/runners/realtime/token",
    headers: authHeadersSchema,
    body: z.object({
      group: runnerGroupSchema,
    }),
    responses: {
      200: ablyTokenRequestSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get Ably token for runner group job notifications",
  },
});

export type RunnerRealtimeTokenContract = typeof runnerRealtimeTokenContract;

/**
 * Platform realtime token contract for /api/zero/realtime/token
 * Used by the frontend to get an Ably token for subscribing to user-scoped push signals.
 */
export const platformRealtimeTokenContract = c.router({
  /**
   * POST /api/zero/realtime/token
   * Get an Ably token to subscribe to the authenticated user's push channel
   */
  create: {
    method: "POST",
    path: "/api/zero/realtime/token",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: ablyTokenRequestSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get Ably token for platform user push notifications",
  },
});

export type PlatformRealtimeTokenContract =
  typeof platformRealtimeTokenContract;
