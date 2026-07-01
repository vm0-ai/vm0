import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testUserExportStateActionBodySchema = z
  .object({
    action: z.enum(["delete-user-export-state"]),
  })
  .passthrough();

export const testUserExportStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testUserExportStateErrorSchema = z.object({
  error: z.string(),
});

export const testUserExportStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/user-export-state/action",
    body: testUserExportStateActionBodySchema,
    responses: {
      200: testUserExportStateActionResponseSchema,
      400: testUserExportStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate or inspect user export test state",
  },
});

export type TestUserExportStateActionBody = z.infer<
  typeof testUserExportStateActionBodySchema
>;
export type TestUserExportStateActionResponse = z.infer<
  typeof testUserExportStateActionResponseSchema
>;
export type TestUserExportStateContract = typeof testUserExportStateContract;
