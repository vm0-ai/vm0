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

/**
 * Job schema for polling response
 */
export const jobSchema = z.object({
  runId: z.string().uuid(),
  prompt: z.string(),
  agentComposeVersionId: z.string(),
  vars: z.record(z.string(), z.string()).nullable(),
  secretNames: z.array(z.string()).nullable(),
  checkpointId: z.string().uuid().nullable(),
});

/**
 * Runners poll contract - GET /api/runners/poll
 * Long-polling endpoint to fetch pending jobs for a runner group
 */
export const runnersPollContract = c.router({
  poll: {
    method: "GET",
    path: "/api/runners/poll",
    query: z.object({
      group: runnerGroupSchema,
    }),
    responses: {
      200: z.object({
        job: jobSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll for pending jobs (long-polling with 30s timeout)",
  },
});

/**
 * Execution context returned when claiming a job
 */
export const executionContextSchema = z.object({
  runId: z.string().uuid(),
  prompt: z.string(),
  agentComposeVersionId: z.string(),
  vars: z.record(z.string(), z.string()).nullable(),
  secretNames: z.array(z.string()).nullable(),
  checkpointId: z.string().uuid().nullable(),
  sandboxToken: z.string(),
  apiUrl: z.string(),
});

/**
 * Runners job claim contract - POST /api/runners/jobs/:id/claim
 * Claim a pending job for execution
 */
export const runnersJobClaimContract = c.router({
  claim: {
    method: "POST",
    path: "/api/runners/jobs/:id/claim",
    pathParams: z.object({
      id: z.string().uuid(),
    }),
    body: z.object({
      runnerId: z.string().uuid(),
    }),
    responses: {
      200: executionContextSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema, // Already claimed
      500: apiErrorSchema,
    },
    summary: "Claim a pending job for execution",
  },
});

export type RunnersRegisterContract = typeof runnersRegisterContract;
export type RunnersPollContract = typeof runnersPollContract;
export type RunnersJobClaimContract = typeof runnersJobClaimContract;
export type RunnerResponse = z.infer<typeof runnerResponseSchema>;
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;
export type Job = z.infer<typeof jobSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
