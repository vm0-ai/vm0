import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTelegramDispatchProbeBodySchema = z.unknown().optional();

export const testTelegramDispatchProbeSuccessSchema = z.object({
  ok: z.literal(true),
});

export const testTelegramDispatchProbeValidationErrorSchema = z.object({
  error: z.string(),
});

export const testTelegramDispatchProbeHandlerErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
    stack: z.string().optional(),
  }),
});

export const testTelegramDispatchProbeContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/telegram-dispatch-probe",
    body: testTelegramDispatchProbeBodySchema,
    responses: {
      200: z.union([
        testTelegramDispatchProbeSuccessSchema,
        testTelegramDispatchProbeHandlerErrorSchema,
      ]),
      400: testTelegramDispatchProbeValidationErrorSchema,
      404: z.string(),
    },
    summary:
      "Dispatch a synthetic Telegram E2E message through the real handler",
  },
});

export type TestTelegramDispatchProbeContract =
  typeof testTelegramDispatchProbeContract;
