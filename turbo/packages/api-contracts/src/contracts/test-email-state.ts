import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testEmailStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-fixture",
      "delete-fixture",
      "seed-agent-session",
      "seed-run",
      "seed-thread",
      "seed-reply-callback",
      "seed-trigger-callback",
      "seed-user-cache",
      "seed-outbox",
      "delete-outbox-by-subject",
      "touch-outbox",
      "get-outbox-by-subject",
      "seed-suppression",
      "delete-suppression",
      "delete-org-metadata",
      "get-thread",
      "get-run-state",
      "get-suppressions",
      "get-user",
      "get-outbox",
    ]),
  })
  .passthrough();

export const testEmailStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testEmailStateErrorSchema = z.object({
  error: z.string(),
});

export const testEmailStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/email-state/action",
    body: testEmailStateActionBodySchema,
    responses: {
      200: testEmailStateActionResponseSchema,
      400: testEmailStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate or inspect Zero email test state",
  },
});

export type TestEmailStateActionBody = z.infer<
  typeof testEmailStateActionBodySchema
>;
export type TestEmailStateActionResponse = z.infer<
  typeof testEmailStateActionResponseSchema
>;
export type TestEmailStateContract = typeof testEmailStateContract;
