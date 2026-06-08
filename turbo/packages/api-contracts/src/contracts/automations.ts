import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Automations API surface (SI-3). A cleaned product view over the shared
 * automation service that also backs the legacy `/api/zero/schedules` routes.
 * The field set is the post-cleanup schedule set (no secrets / vars /
 * volumeVersions); the two surfaces drive the same service and therefore the
 * same agent run + chat-thread rendering. Gated behind the `zeroAutomations`
 * feature switch — when off, these endpoints are not mounted (404).
 */

/**
 * Automation response schema — shared by all automation endpoints. Mirrors the
 * cleaned schedule projection of a `zero_agent_schedules` row.
 */
export const automationResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  displayName: z.string().nullable(),
  userId: z.string(),
  name: z.string(),
  triggerType: z.enum(["cron", "once", "loop"]),
  cronExpression: z.string().nullable(),
  atTime: z.string().nullable(),
  intervalSeconds: z.number().nullable(),
  timezone: z.string(),
  prompt: z.string(),
  description: z.string().nullable(),
  appendSystemPrompt: z.string().nullable(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  retryStartedAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  // Linked chat thread. Set at creation and immutable after (any chatThreadId
  // supplied on update is ignored). Every automation is linked to a chat
  // thread, so this is always present.
  chatThreadId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const automationListResponseSchema = z.object({
  automations: z.array(automationResponseSchema),
});

export const automationMutationResponseSchema = z.object({
  automation: automationResponseSchema,
  created: z.boolean(),
});

const automationTriggerRefinement = (data: {
  readonly cronExpression?: string;
  readonly atTime?: string;
  readonly intervalSeconds?: number;
}): boolean => {
  const triggers = [
    data.cronExpression,
    data.atTime,
    data.intervalSeconds,
  ].filter((v) => {
    return v !== undefined;
  });
  return triggers.length === 1;
};

const automationTriggerRefinementMessage = {
  message:
    "Exactly one of 'cronExpression', 'atTime', or 'intervalSeconds' must be specified",
};

/**
 * Create request — requires agentId (compose UUID) and name. Exactly one
 * trigger must be specified.
 */
const createAutomationRequestSchema = z
  .object({
    name: z.string().min(1).max(64, "Automation name max 64 chars"),
    cronExpression: z.string().optional(),
    atTime: z.string().optional(),
    intervalSeconds: z.number().int().min(0).optional(),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1, "Prompt required"),
    description: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    agentId: z.string().uuid("Invalid agent ID"),
    enabled: z.boolean().optional(),
    // Chat-thread linkage, honored only on creation. When provided, links the
    // automation to an existing owned chat thread; when omitted, the server
    // creates a web chat thread and links it.
    chatThreadId: z.string().uuid("Invalid chat thread ID").optional(),
  })
  .refine(automationTriggerRefinement, automationTriggerRefinementMessage);

/**
 * Update request — the name is taken from the path; the body carries the agent
 * and the new definition. The chat-thread link is immutable on update (any
 * chatThreadId is silently ignored), matching the legacy schedule deploy.
 */
const updateAutomationRequestSchema = z
  .object({
    cronExpression: z.string().optional(),
    atTime: z.string().optional(),
    intervalSeconds: z.number().int().min(0).optional(),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1, "Prompt required"),
    description: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    agentId: z.string().uuid("Invalid agent ID"),
    enabled: z.boolean().optional(),
  })
  .refine(automationTriggerRefinement, automationTriggerRefinementMessage);

/**
 * Automations collection contract (GET/POST /api/automations).
 */
export const automationsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/automations",
    headers: authHeadersSchema,
    body: createAutomationRequestSchema,
    responses: {
      200: automationMutationResponseSchema,
      201: automationMutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create an automation",
  },
  list: {
    method: "GET",
    path: "/api/automations",
    headers: authHeadersSchema,
    responses: {
      200: automationListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List all automations",
  },
});

/**
 * Automation by-name contract (PUT/DELETE /api/automations/:name).
 */
export const automationsByNameContract = c.router({
  update: {
    method: "PUT",
    path: "/api/automations/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Automation name required"),
    }),
    body: updateAutomationRequestSchema,
    responses: {
      200: automationMutationResponseSchema,
      201: automationMutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update an automation",
  },
  delete: {
    method: "DELETE",
    path: "/api/automations/:name",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Automation name required"),
    }),
    query: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete an automation",
  },
});

/**
 * Automation enable/disable contract.
 */
export const automationsEnableContract = c.router({
  enable: {
    method: "POST",
    path: "/api/automations/:name/enable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Automation name required"),
    }),
    body: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      200: automationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Enable an automation",
  },
  disable: {
    method: "POST",
    path: "/api/automations/:name/disable",
    headers: authHeadersSchema,
    pathParams: z.object({
      name: z.string().min(1, "Automation name required"),
    }),
    body: z.object({
      agentId: z.string().uuid("Invalid agent ID"),
    }),
    responses: {
      200: automationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable an automation",
  },
});

/**
 * Automation run-now contract (POST /api/automations/run).
 */
export const automationRunContract = c.router({
  run: {
    method: "POST",
    path: "/api/automations/run",
    headers: authHeadersSchema,
    body: z.object({
      automationId: z.string().uuid("Invalid automation ID"),
    }),
    responses: {
      201: z.object({ runId: z.string() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Execute an automation immediately (run now)",
  },
});

// Contract type exports
export type AutomationsMainContract = typeof automationsMainContract;
export type AutomationsByNameContract = typeof automationsByNameContract;
export type AutomationsEnableContract = typeof automationsEnableContract;
export type AutomationRunContract = typeof automationRunContract;

// Inferred types from response schemas
export type AutomationResponse = z.infer<typeof automationResponseSchema>;
export type AutomationListResponse = z.infer<
  typeof automationListResponseSchema
>;
export type AutomationMutationResponse = z.infer<
  typeof automationMutationResponseSchema
>;
