import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Runner group format: scope/name (e.g., "acme/production")
 */
export const runnerGroupSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[a-z0-9-]+$/,
    "Runner group must be in scope/name format (e.g., acme/production)",
  );

/**
 * Runner status
 */
export const runnerStatusSchema = z.enum(["online", "offline", "busy"]);

/**
 * Runner response schema
 */
export const runnerResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  group: z.string(),
  status: runnerStatusSchema,
  lastHeartbeatAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

/**
 * Runners registration contract - POST /api/runners/register
 */
export const runnersRegisterContract = c.router({
  register: {
    method: "POST",
    path: "/api/runners/register",
    body: z.object({
      name: z.string().min(1).max(255),
      group: runnerGroupSchema,
    }),
    responses: {
      200: runnerResponseSchema,
      201: runnerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Register or update a runner",
  },
});

export type RunnersRegisterContract = typeof runnersRegisterContract;
export type RunnerResponse = z.infer<typeof runnerResponseSchema>;
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;
