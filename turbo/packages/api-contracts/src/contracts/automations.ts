import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The unified Automation resource API: one automation = identity + intent
 * (agent, instruction, one linked chat thread, enabled), carrying N triggers
 * (cron / once / loop / webhook) that only decide WHEN it fires. It replaced
 * the split schedule/webhook surfaces (deleted in #17307) and lives on the
 * /api/automations* paths.
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
  z.object({
    ...triggerBaseShape,
    kind: z.literal("webhook"),
    // Unguessable URL token identifying the inbound trigger. Identity only;
    // the HMAC signing secret is separate and surfaced exactly once (at
    // creation or rotation).
    webhookToken: z.string(),
    webhookUrl: z.string(),
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

/**
 * Trigger creation input: the kind plus exactly its own config. Webhook
 * triggers mint their token + HMAC secret server-side.
 */
export const createTriggerRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    cronExpression: z.string().min(1),
    timezone: z.string().optional(),
  }),
  z.object({
    kind: z.literal("once"),
    atTime: z.string().min(1),
    timezone: z.string().optional(),
  }),
  z.object({
    kind: z.literal("loop"),
    intervalSeconds: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("webhook"),
  }),
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
  // Create-with-first-trigger sugar; a triggerless automation is allowed.
  trigger: createTriggerRequestSchema.optional(),
});

const updateAutomationRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  instruction: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
});

/**
 * Create/rotate responses surface the webhook HMAC `secret` exactly once;
 * callers must persist it on receipt because it is unrecoverable.
 */
export const automationMutationResponseSchema = z.object({
  automation: automationResponseSchema,
  webhookSecret: z.string().optional(),
});

export const triggerMutationResponseSchema = z.object({
  trigger: automationTriggerResponseSchema,
  webhookSecret: z.string().optional(),
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
    summary: "Create an automation (optionally with its first trigger)",
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
    summary: "Enable an automation (all triggers resume)",
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
    summary: "Disable an automation (suspends all triggers)",
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
  addTrigger: {
    method: "POST",
    path: "/api/automations/:ref/triggers",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    body: createTriggerRequestSchema,
    responses: {
      201: triggerMutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Add a trigger to an automation",
  },
  listTriggers: {
    method: "GET",
    path: "/api/automations/:ref/triggers",
    headers: authHeadersSchema,
    pathParams: refParamsSchema,
    responses: {
      200: z.object({
        triggers: z.array(automationTriggerResponseSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List an automation's triggers",
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
  remove: {
    method: "DELETE",
    path: "/api/automation-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParamsSchema,
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Remove a trigger",
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
  rotateSecret: {
    method: "POST",
    path: "/api/automation-triggers/:id/rotate-secret",
    headers: authHeadersSchema,
    pathParams: triggerIdParamsSchema,
    body: z.object({}).optional(),
    responses: {
      200: triggerMutationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Rotate a webhook trigger's HMAC secret (returned once)",
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
