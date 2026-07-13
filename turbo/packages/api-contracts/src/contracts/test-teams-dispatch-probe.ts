import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTeamsDispatchProbeBodySchema = z.object({
  tenant_id: z.string(),
  conversation_id: z.string(),
  teams_user_id: z.string(),
  message_text: z.string(),
  service_url: z.string().optional(),
  tenant_name: z.string().nullable().optional(),
  team_id: z.string().nullable().optional(),
  team_name: z.string().nullable().optional(),
  channel_id: z.string().nullable().optional(),
  conversation_type: z.enum(["personal", "channel"]).optional(),
  activity_id: z.string().nullable().optional(),
  thread_id: z.string().optional(),
  teams_aad_object_id: z.string().nullable().optional(),
  teams_user_display_name: z.string().nullable().optional(),
  teams_user_principal_name: z.string().nullable().optional(),
  bot_id: z.string().nullable().optional(),
  bot_name: z.string().nullable().optional(),
});

export const testTeamsDispatchProbeErrorSchema = z.object({
  error: z.string(),
});

export const testTeamsDispatchProbeSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export const testTeamsDispatchProbeFailureResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
    stack: z.string().optional(),
  }),
});

export const testTeamsDispatchProbeResponseSchema = z.union([
  testTeamsDispatchProbeSuccessResponseSchema,
  testTeamsDispatchProbeFailureResponseSchema,
]);

export const testTeamsDispatchProbeContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/teams-dispatch-probe",
    body: testTeamsDispatchProbeBodySchema,
    responses: {
      200: testTeamsDispatchProbeResponseSchema,
      400: testTeamsDispatchProbeErrorSchema,
      404: z.string(),
    },
    summary: "Synchronously dispatch a Teams test message for diagnostics",
  },
});

export type TestTeamsDispatchProbeBody = z.infer<
  typeof testTeamsDispatchProbeBodySchema
>;
export type TestTeamsDispatchProbeContract =
  typeof testTeamsDispatchProbeContract;
export type TestTeamsDispatchProbeResponse = z.infer<
  typeof testTeamsDispatchProbeResponseSchema
>;
