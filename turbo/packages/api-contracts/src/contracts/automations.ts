import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The unified Automation resource API: one automation = identity + intent
 * (agent, instruction, one linked chat thread, enabled), carrying one schedule
 * trigger (cron / once / loop) that decides WHEN it fires. It replaced the
 * legacy schedule surfaces and lives on the /api/automations* paths.
 *
 * `:ref` resolves an automation by id (UUID) or by name; a name shared across
 * agents within the org/user scope is ambiguous and rejected with 400 — use
 * the id. Triggers are addressed by their auto-assigned id only.
 */

const triggerBaseShape = {
  id: z.string().uuid(),
  automationId: z.string().uuid(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

const timeTriggerRuntimeShape = {
  timezone: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  consecutiveFailures: z.number(),
};

export const automationTriggerResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    ...triggerBaseShape,
    kind: z.literal("cron"),
    cronExpression: z.string(),
    ...timeTriggerRuntimeShape,
  }),
  z.object({
    ...triggerBaseShape,
    kind: z.literal("once"),
    atTime: z.string(),
    ...timeTriggerRuntimeShape,
  }),
  z.object({
    ...triggerBaseShape,
    kind: z.literal("loop"),
    intervalSeconds: z.number(),
    ...timeTriggerRuntimeShape,
  }),
]);

export const automationResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  displayName: z.string().nullable(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  instruction: z.string(),
  appendSystemPrompt: z.string().nullable(),
  enabled: z.boolean(),
  chatThreadId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  triggers: z.array(automationTriggerResponseSchema),
});

export const automationListResponseSchema = z.object({
  automations: z.array(automationResponseSchema),
});

const cronTriggerConfigSchema = z.object({
  kind: z.literal("cron"),
  cronExpression: z.string().min(1),
  timezone: z.string().optional(),
});

const onceTriggerConfigSchema = z.object({
  kind: z.literal("once"),
  atTime: z.string().min(1),
  timezone: z.string().optional(),
});

const loopTriggerConfigSchema = z.object({
  kind: z.literal("loop"),
  intervalSeconds: z.number().int().positive(),
});

/** Trigger creation input: the kind plus exactly its own config. */
export const createTriggerRequestSchema = z.discriminatedUnion("kind", [
  cronTriggerConfigSchema,
  onceTriggerConfigSchema,
  loopTriggerConfigSchema,
]);

/**
 * Trigger update input: updating replaces the trigger's schedule in place —
 * id, enabled flag, and lastRunId history are preserved; nextRunAt is
 * recomputed and the consecutive-failure counter resets (same revive
 * semantics as enable). The kind may switch among cron/once/loop.
 */
export const updateTriggerRequestSchema = z.discriminatedUnion("kind", [
  cronTriggerConfigSchema,
  onceTriggerConfigSchema,
  loopTriggerConfigSchema,
]);

const createAutomationRequestSchema = z.object({
  name: z.string().min(1).max(64, "Automation name max 64 chars"),
  agentId: z.string().uuid("Invalid agent ID"),
  instruction: z.string().min(1, "Instruction required"),
  description: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  enabled: z.boolean().optional(),
  // Chat-thread linkage, honored only on creation. When provided, links the
  // automation to an existing owned chat thread; when omitted, the server
  // creates a web chat thread and links it.
  chatThreadId: z.string().uuid("Invalid chat thread ID").optional(),
  trigger: createTriggerRequestSchema,
});

const updateAutomationRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  instruction: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
});

export const automationMutationResponseSchema = z.object({
  automation: automationResponseSchema,
});

export const triggerMutationResponseSchema = z.object({
  trigger: automationTriggerResponseSchema,
});

export const automationRunResponseSchema = z.object({
  runId: z.string(),
});

const refParamsSchema = z.object({
  // Automation id (UUID) or unique name within the org/user scope.
  ref: z.string().min(1),
});

const triggerIdParamsSchema = z.object({
  id: z.string().uuid("Invalid trigger ID"),
});

export const automationsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/automations",
    headers: authHeadersSchema,
    body: createAutomationRequestSchema,
    responses: {
      201: automationMutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create an automation with its schedule trigger",
  },
  list: {
    method: "GET",
    path: "/api/automations",
    headers: authHeadersSchema,
    responses: {
      200: automationListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List automations with their triggers",
  },
});

export const automationsByRefContract = c.router({
  show: {
    method: "GET",
    path: "/api/automations/:ref",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    responses: {
      200: automationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Show an automation and its triggers",
  },
  update: {
    method: "PATCH",
    path: "/api/automations/:ref",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    body: updateAutomationRequestSchema,
    responses: {
      200: automationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update an automation's identity/intent fields",
  },
  delete: {
    method: "DELETE",
    path: "/api/automations/:ref",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete an automation (its triggers cascade)",
  },
  enable: {
    method: "POST",
    path: "/api/automations/:ref/enable",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    body: z.object({}).optional(),
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
    path: "/api/automations/:ref/disable",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    body: z.object({}).optional(),
    responses: {
      200: automationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable an automation",
  },
  run: {
    method: "POST",
    path: "/api/automations/:ref/run",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    body: z.object({}).optional(),
    responses: {
      201: automationRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Manually fire an automation (instruction-only, no event)",
  },
});

export const automationTriggersContract = c.router({
  show: {
    method: "GET",
    path: "/api/automation-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParamsSchema,
    responses: {
      200: automationTriggerResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Show a trigger",
  },
  update: {
    method: "PATCH",
    path: "/api/automation-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParamsSchema,
    body: updateTriggerRequestSchema,
    responses: {
      200: automationTriggerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Replace a time trigger's schedule config (kind may switch among cron/once/loop)",
  },
  enable: {
    method: "POST",
    path: "/api/automation-triggers/:id/enable",
    headers: authHeadersSchema,
    pathParams: triggerIdParamsSchema,
    body: z.object({}).optional(),
    responses: {
      200: automationTriggerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Enable a single trigger",
  },
  disable: {
    method: "POST",
    path: "/api/automation-triggers/:id/disable",
    headers: authHeadersSchema,
    pathParams: triggerIdParamsSchema,
    body: z.object({}).optional(),
    responses: {
      200: automationTriggerResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable a single trigger",
  },
});

export type AutomationsMainContract = typeof automationsMainContract;
export type AutomationsByRefContract = typeof automationsByRefContract;
export type AutomationTriggersContract = typeof automationTriggersContract;

export type AutomationResponse = z.infer<typeof automationResponseSchema>;
export type AutomationTriggerResponse = z.infer<
  typeof automationTriggerResponseSchema
>;
export type CreateTriggerRequest = z.infer<typeof createTriggerRequestSchema>;
export type UpdateTriggerRequest = z.infer<typeof updateTriggerRequestSchema>;
