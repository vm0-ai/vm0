import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testZeroAgentStateErrorSchema = z.object({
  error: z.string(),
});

const zeroAgentVisibilitySchema = z.enum(["public", "private"]);

export const testZeroAgentStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-agent"),
      agent_id: z.string(),
      display_name: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      sound: z.string().nullable().optional(),
      avatar_url: z.string().nullable().optional(),
      visibility: zeroAgentVisibilitySchema.optional(),
    }),
  ],
);

export const testZeroAgentStateActionResponseSchema = z.object({
  ok: z.literal(true),
});

export const testZeroAgentStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/zero-agent-state/action",
    body: testZeroAgentStateActionBodySchema,
    responses: {
      200: testZeroAgentStateActionResponseSchema,
      400: testZeroAgentStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate Zero agent API test support state",
  },
});

export type TestZeroAgentStateContract = typeof testZeroAgentStateContract;
export type TestZeroAgentStateActionBody = z.infer<
  typeof testZeroAgentStateActionBodySchema
>;
export type TestZeroAgentStateActionResponse = z.infer<
  typeof testZeroAgentStateActionResponseSchema
>;
