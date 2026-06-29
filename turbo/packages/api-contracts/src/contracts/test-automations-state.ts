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

export const testAutomationsStateTriggerRowSchema = z.object({
  id: z.string(),
  automation_id: z.string(),
  kind: z.enum(["cron", "once", "loop"]),
  cron_expression: z.string().nullable(),
  at_time: z.string().nullable(),
  interval_seconds: z.number().nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  next_run_at: z.string().nullable(),
  last_run_id: z.string().nullable(),
  consecutive_failures: z.number(),
});

export const testAutomationsStateReadResponseSchema = z.object({
  automation: z
    .object({
      id: z.string(),
      org_id: z.string(),
      enabled: z.boolean(),
      interpreter_kind: z.string(),
      chat_thread_id: z.string(),
      chat_thread: z
        .object({
          title: z.string().nullable(),
          user_id: z.string(),
          agent_compose_id: z.string(),
        })
        .nullable(),
    })
    .nullable(),
  triggers: z.array(testAutomationsStateTriggerRowSchema),
  runs: z.array(
    z.object({
      id: z.string(),
      automation_id: z.string().nullable(),
    }),
  ),
  run: z
    .object({
      zero_run: z
        .object({
          trigger_source: z.string().nullable(),
          automation_id: z.string().nullable(),
          trigger_id: z.string().nullable(),
          chat_thread_id: z.string().nullable(),
        })
        .nullable(),
      agent_run: z
        .object({
          prompt: z.string().nullable(),
          append_system_prompt: z.string().nullable(),
        })
        .nullable(),
      callbacks: z.array(
        z.object({
          url: z.string().nullable(),
          internal_kind: z.string().nullable(),
          payload: z.unknown(),
        }),
      ),
      messages: z.array(
        z.object({
          role: z.string(),
          content: z.string(),
          automation_title: z.string().nullable(),
          automation_snapshot: z.unknown(),
        }),
      ),
    })
    .nullable(),
});

export const testAutomationsStatePatchBodySchema = z.object({
  trigger_id: z.string().optional(),
  automation_id: z.string().optional(),
  at_time: z.string().nullable().optional(),
  next_run_at: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  last_run_id: z.string().nullable().optional(),
  consecutive_failures: z.number().int().nonnegative().optional(),
});

export const testAutomationsStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("cleanup-created-automations"),
      org_id: z.string(),
    }),
    z.object({
      action: z.literal("seed-compose"),
      org_id: z.string(),
      user_id: z.string(),
      compose_id: z.string().optional(),
    }),
    z.object({
      action: z.literal("delete-compose"),
      compose_id: z.string(),
    }),
    z.object({
      action: z.literal("seed-run"),
      org_id: z.string(),
      user_id: z.string(),
      compose_id: z.string(),
      status: z.string().optional(),
      prompt: z.string().optional(),
    }),
    z.object({
      action: z.literal("delete-org-member"),
      org_id: z.string(),
      user_id: z.string(),
    }),
    z.object({
      action: z.literal("enable-fake-kms"),
    }),
    z.object({
      action: z.literal("reset-fake-kms"),
    }),
  ],
);

export const testAutomationsStateActionResponseSchema = z.object({
  ok: z.literal(true),
  compose_id: z.string().optional(),
  run_id: z.string().optional(),
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
  get: {
    method: "GET",
    path: "/api/test/automations-state/read",
    query: z.object({
      automation_id: z.string().optional(),
      automation_ids: z.string().optional(),
      run_id: z.string().optional(),
      org_id: z.string().optional(),
    }),
    responses: {
      200: testAutomationsStateReadResponseSchema,
      404: z.string(),
    },
    summary: "Read automations API test state",
  },
  patch: {
    method: "PATCH",
    path: "/api/test/automations-state/trigger",
    body: testAutomationsStatePatchBodySchema,
    responses: {
      200: testAutomationsStateDeleteResponseSchema,
      400: testAutomationsStateErrorSchema,
      404: z.string(),
    },
    summary: "Patch automation trigger runtime state",
  },
  action: {
    method: "POST",
    path: "/api/test/automations-state/action",
    body: testAutomationsStateActionBodySchema,
    responses: {
      200: testAutomationsStateActionResponseSchema,
      400: testAutomationsStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate automations API test support state",
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
export type TestAutomationsStateReadResponse = z.infer<
  typeof testAutomationsStateReadResponseSchema
>;
export type TestAutomationsStateTriggerRow = z.infer<
  typeof testAutomationsStateTriggerRowSchema
>;
export type TestAutomationsStatePatchBody = z.infer<
  typeof testAutomationsStatePatchBodySchema
>;
export type TestAutomationsStateActionBody = z.infer<
  typeof testAutomationsStateActionBodySchema
>;
export type TestAutomationsStateActionResponse = z.infer<
  typeof testAutomationsStateActionResponseSchema
>;
