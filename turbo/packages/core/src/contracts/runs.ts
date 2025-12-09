import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Run status enum
 */
const runStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
]);

/**
 * Unified run request schema - supports all run modes via optional parameters
 */
const unifiedRunRequestSchema = z.object({
  // High-level shortcuts (mutually exclusive with each other)
  checkpointId: z.string().optional(),
  sessionId: z.string().optional(),

  // Base parameters (can be used directly or overridden after shortcut expansion)
  agentComposeId: z.string().optional(),
  agentComposeVersionId: z.string().optional(),
  conversationId: z.string().optional(),
  artifactName: z.string().optional(),
  artifactVersion: z.string().optional(),
  templateVars: z.record(z.string(), z.string()).optional(),
  volumeVersions: z.record(z.string(), z.string()).optional(),

  // Required
  prompt: z.string().min(1, "Missing prompt"),
});

/**
 * Create run response schema
 */
const createRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  sandboxId: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  executionTimeMs: z.number().optional(),
  createdAt: z.string(),
});

/**
 * Get run response schema
 */
const getRunResponseSchema = z.object({
  runId: z.string(),
  agentComposeVersionId: z.string(),
  status: runStatusSchema,
  prompt: z.string(),
  templateVars: z.record(z.string(), z.string()).optional(),
  sandboxId: z.string().optional(),
  result: z
    .object({
      output: z.string(),
      executionTimeMs: z.number(),
    })
    .optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

/**
 * Run event schema
 */
const runEventSchema = z.object({
  sequenceNumber: z.number(),
  eventType: z.string(),
  eventData: z.unknown(),
  createdAt: z.string(),
});

/**
 * Events response schema
 */
const eventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  hasMore: z.boolean(),
  nextSequence: z.number(),
  status: runStatusSchema,
});

/**
 * Runs main route contract (/api/agent/runs)
 * Handles POST create
 */
export const runsMainContract = c.router({
  /**
   * POST /api/agent/runs
   * Create and execute a new agent run
   */
  create: {
    method: "POST",
    path: "/api/agent/runs",
    body: unifiedRunRequestSchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create and execute agent run",
  },
});

/**
 * Runs by ID route contract (/api/agent/runs/[id])
 */
export const runsByIdContract = c.router({
  /**
   * GET /api/agent/runs/:id
   * Get agent run status and results
   */
  getById: {
    method: "GET",
    path: "/api/agent/runs/:id",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: getRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run by ID",
  },
});

/**
 * Run events route contract (/api/agent/runs/[id]/events)
 */
export const runEventsContract = c.router({
  /**
   * GET /api/agent/runs/:id/events
   * Poll for agent run events with pagination
   */
  getEvents: {
    method: "GET",
    path: "/api/agent/runs/:id/events",
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().default(0),
      limit: z.coerce.number().default(100),
    }),
    responses: {
      200: eventsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run events",
  },
});

export type RunsMainContract = typeof runsMainContract;
export type RunsByIdContract = typeof runsByIdContract;
export type RunEventsContract = typeof runEventsContract;

// Export schemas for reuse
export {
  runStatusSchema,
  unifiedRunRequestSchema,
  createRunResponseSchema,
  getRunResponseSchema,
  runEventSchema,
  eventsResponseSchema,
};
