import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const testComputerUseStateErrorSchema = z.object({
  error: z.string(),
});

export const testComputerUseStatePostBodySchema = z.object({
  user_id: z.string().optional(),
  org_id: z.string().optional(),
  trigger_source: z.enum(["web", "slack"]).optional(),
});

export const testComputerUseStatePostResponseSchema = z.object({
  ok: z.literal(true),
  compose_id: z.string(),
  run_id: z.string(),
  session_id: z.string(),
  thread_id: z.string().nullable(),
  slack: z
    .object({
      connection_id: z.string(),
      channel_id: z.string(),
      thread_ts: z.string(),
    })
    .nullable(),
});

export const testComputerUseStateGetResponseSchema = z.object({
  source: z.enum(["web", "slack"]).nullable(),
  computer_use_host_id: z.string().nullable(),
});

export const testComputerUseStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const testComputerUseStateContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/computer-use-state",
    body: testComputerUseStatePostBodySchema,
    responses: {
      200: testComputerUseStatePostResponseSchema,
      400: testComputerUseStateErrorSchema,
      404: z.string(),
    },
    summary: "Seed computer-use e2e run state",
  },
  get: {
    method: "GET",
    path: "/api/test/computer-use-state",
    query: z.object({
      run_id: z.string().optional(),
    }),
    responses: {
      200: testComputerUseStateGetResponseSchema,
      400: testComputerUseStateErrorSchema,
      404: z.string(),
    },
    summary: "Read computer-use e2e run state",
  },
  delete: {
    method: "DELETE",
    path: "/api/test/computer-use-state",
    query: z.object({
      run_id: z.string().optional(),
    }),
    responses: {
      200: testComputerUseStateDeleteResponseSchema,
      400: testComputerUseStateErrorSchema,
      404: z.string(),
    },
    summary: "Clear computer-use e2e run state",
  },
});

export type TestComputerUseStateContract = typeof testComputerUseStateContract;
export type TestComputerUseStatePostResponse = z.infer<
  typeof testComputerUseStatePostResponseSchema
>;
export type TestComputerUseStateGetResponse = z.infer<
  typeof testComputerUseStateGetResponseSchema
>;
export type TestComputerUseStateDeleteResponse = z.infer<
  typeof testComputerUseStateDeleteResponseSchema
>;
