import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTelegramMockPathParamsSchema = z.object({
  botToken: z.string(),
  method: z.string(),
});

export const testTelegramMockSuccessResponseSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
});

export const testTelegramMockErrorResponseSchema = z.object({
  ok: z.literal(false),
  description: z.string(),
});

export const testTelegramMockContract = c.router({
  post: {
    method: "POST",
    path: "/api/test/telegram-mock/:botToken/:method",
    pathParams: testTelegramMockPathParamsSchema,
    body: z.unknown().optional(),
    responses: {
      200: testTelegramMockSuccessResponseSchema,
      404: z.union([z.string(), testTelegramMockErrorResponseSchema]),
    },
    summary: "Handle Telegram Bot API E2E mock calls",
  },
});

export type TestTelegramMockContract = typeof testTelegramMockContract;
