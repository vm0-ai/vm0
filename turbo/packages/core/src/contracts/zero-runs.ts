import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  createRunResponseSchema,
  getRunResponseSchema,
  cancelRunResponseSchema,
  agentEventsResponseSchema,
  queueResponseSchema,
  unifiedRunRequestSchema,
} from "./runs";

/**
 * Zero run request schema — same as unified but without triggerSource
 * (the proxy injects triggerSource: "web" automatically).
 */
const zeroRunRequestSchema = unifiedRunRequestSchema.omit({
  triggerSource: true,
});

const c = initContract();

/**
 * Zero runs main contract (POST /api/zero/runs)
 * Proxies to runsMainContract.create
 */
export const zeroRunsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/runs",
    headers: authHeadersSchema,
    body: zeroRunRequestSchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create and execute agent run (zero proxy)",
  },
});

/**
 * Zero runs by ID contract (GET /api/zero/runs/:id)
 * Proxies to runsByIdContract
 */
export const zeroRunsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/zero/runs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    responses: {
      200: getRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run by ID (zero proxy)",
  },
});

/**
 * Zero runs cancel contract (POST /api/zero/runs/:id/cancel)
 * Proxies to runsCancelContract
 */
export const zeroRunsCancelContract = c.router({
  cancel: {
    method: "POST",
    path: "/api/zero/runs/:id/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    body: z.undefined(),
    responses: {
      200: cancelRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Cancel a pending or running run (zero proxy)",
  },
});

/**
 * Zero runs queue contract (GET /api/zero/runs/queue)
 * Proxies to runsQueueContract
 */
export const zeroRunsQueueContract = c.router({
  getQueue: {
    method: "GET",
    path: "/api/zero/runs/queue",
    headers: authHeadersSchema,
    responses: {
      200: queueResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get org run queue status (zero proxy)",
  },
});

/**
 * Zero run agent events contract (GET /api/zero/runs/:id/telemetry/agent)
 * Proxies to runAgentEventsContract
 */
export const zeroRunAgentEventsContract = c.router({
  getAgentEvents: {
    method: "GET",
    path: "/api/zero/runs/:id/telemetry/agent",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Run ID is required"),
    }),
    query: z.object({
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(100).default(5),
      order: z.enum(["asc", "desc"]).default("desc"),
    }),
    responses: {
      200: agentEventsResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent events with pagination (zero proxy)",
  },
});

// Type exports
export type ZeroRunsMainContract = typeof zeroRunsMainContract;
export type ZeroRunsByIdContract = typeof zeroRunsByIdContract;
export type ZeroRunsCancelContract = typeof zeroRunsCancelContract;
export type ZeroRunsQueueContract = typeof zeroRunsQueueContract;
export type ZeroRunAgentEventsContract = typeof zeroRunAgentEventsContract;
