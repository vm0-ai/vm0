import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testSlackDispatchProbeBodySchema = z.object({
  team_id: z.string(),
  channel_id: z.string(),
  user_id: z.string(),
  message_text: z.string(),
  message_ts: z.string(),
  channel_type: z.enum(["channel", "im"]).optional(),
});

export const testSlackDispatchProbeErrorSchema = z.object({
  error: z.string(),
});

export const testSlackDispatchProbeSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export const testSlackDispatchProbeFailureResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
    stack: z.string().optional(),
  }),
});

export const testSlackDispatchProbeResponseSchema = z.union([
  testSlackDispatchProbeSuccessResponseSchema,
  testSlackDispatchProbeFailureResponseSchema,
]);

export const testSlackDispatchProbeContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/slack-dispatch-probe",
    body: testSlackDispatchProbeBodySchema,
    responses: {
      200: testSlackDispatchProbeResponseSchema,
      400: testSlackDispatchProbeErrorSchema,
      404: z.string(),
    },
    summary: "Synchronously dispatch a Slack test message for diagnostics",
  },
});

export type TestSlackDispatchProbeBody = z.infer<
  typeof testSlackDispatchProbeBodySchema
>;
export type TestSlackDispatchProbeContract =
  typeof testSlackDispatchProbeContract;
export type TestSlackDispatchProbeError = z.infer<
  typeof testSlackDispatchProbeErrorSchema
>;
export type TestSlackDispatchProbeResponse = z.infer<
  typeof testSlackDispatchProbeResponseSchema
>;
