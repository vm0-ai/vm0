import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const userSecretStateSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().nullable(),
  connector_id: z.uuid().nullable(),
  encrypted_value: z.string(),
});

export const testUserConfigStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("set-secret"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      value: z.string(),
      description: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("set-variable"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      value: z.string(),
      description: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("list-secrets"),
      org_id: z.string(),
      user_id: z.string(),
    }),
  ],
);

export const testUserConfigStateActionResponseSchema = z.object({
  ok: z.literal(true),
  secrets: z.array(userSecretStateSchema).optional(),
});

export const testUserConfigStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/user-config-state/action",
    body: testUserConfigStateActionBodySchema,
    responses: {
      200: testUserConfigStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Seed and read user secret and variable API test state",
  },
});

export type TestUserConfigStateActionBody = z.infer<
  typeof testUserConfigStateActionBodySchema
>;
export type TestUserConfigStateActionResponse = z.infer<
  typeof testUserConfigStateActionResponseSchema
>;
