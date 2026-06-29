import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testAutomationsStateErrorSchema = z.object({
  error: z.string(),
});

export const testAutomationsStateSeedSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  description: z.string().nullable().optional(),
  cronExpression: z.string().optional(),
  atTime: z.string().optional(),
  intervalSeconds: z.number().int().positive().optional(),
  triggerType: z.enum(["cron", "once", "loop"]).optional(),
  enabled: z.boolean().optional(),
  nextRunAt: z.string().nullable().optional(),
  lastRunId: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  timezone: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
});

export const testAutomationsStatePostBodySchema = z.object({
  automations: z.array(testAutomationsStateSeedSchema),
  displayName: z.string().optional(),
  agentName: z.string().optional(),
  userName: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  framework: z.enum(["claude-code", "codex"]).optional(),
});

export const testAutomationsStatePostResponseSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  compose_id: z.string(),
  automation_ids: z.array(z.string()),
});

export const testAutomationsStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const testAutomationsStateContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/automations-state",
    body: testAutomationsStatePostBodySchema,
    responses: {
      200: testAutomationsStatePostResponseSchema,
      400: testAutomationsStateErrorSchema,
      404: z.string(),
    },
    summary: "Seed automations API test state",
  },
  delete: {
    method: "DELETE",
    path: "/api/test/automations-state",
    query: z.object({
      org_id: z.string().optional(),
      user_id: z.string().optional(),
      compose_id: z.string().optional(),
      automation_ids: z.string().optional(),
    }),
    responses: {
      200: testAutomationsStateDeleteResponseSchema,
      400: testAutomationsStateErrorSchema,
      404: z.string(),
    },
    summary: "Clear automations API test state",
  },
});

export type TestAutomationsStateContract = typeof testAutomationsStateContract;
export type TestAutomationsStateSeed = z.infer<
  typeof testAutomationsStateSeedSchema
>;
export type TestAutomationsStatePostBody = z.infer<
  typeof testAutomationsStatePostBodySchema
>;
export type TestAutomationsStatePostResponse = z.infer<
  typeof testAutomationsStatePostResponseSchema
>;
export type TestAutomationsStateDeleteResponse = z.infer<
  typeof testAutomationsStateDeleteResponseSchema
>;
