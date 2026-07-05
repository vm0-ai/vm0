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

const refParamsSchema = z.object({
  // Automation id (UUID) or unique name within the org/user scope.
  ref: z.string().min(1),
});

const triggerIdParamsSchema = z.object({
  id: z.string().uuid("Invalid trigger ID"),
});

export const automationsMainContract = c.router({
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
});

export type AutomationsMainContract = typeof automationsMainContract;
export type AutomationsByRefContract = typeof automationsByRefContract;
export type AutomationTriggersContract = typeof automationTriggersContract;

export type AutomationResponse = z.infer<typeof automationResponseSchema>;
export type AutomationTriggerResponse = z.infer<
  typeof automationTriggerResponseSchema
>;
