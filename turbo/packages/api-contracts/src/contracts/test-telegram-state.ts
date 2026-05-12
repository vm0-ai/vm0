import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTelegramStateQuerySchema = z.object({
  bot_id: z.string().optional(),
});

export const testTelegramStateErrorSchema = z.object({
  error: z.string(),
});

export const testTelegramStateComposeVersionSchema = z.object({
  id: z.string(),
  content_keys: z.array(z.string()),
});

export const testTelegramStateResponseSchema = z.object({
  installation: z.unknown().nullable(),
  links: z.array(z.unknown()),
  message_count: z.number(),
  recent_runs: z.array(z.unknown()),
  org_metadata: z.unknown().nullable(),
  default_agent: z.unknown().nullable(),
  default_compose: z.unknown().nullable(),
  default_compose_version: testTelegramStateComposeVersionSchema.nullable(),
  resolved_telegram_api_url: z.string().nullable(),
  mock_calls: z.array(z.unknown()),
});

export const testTelegramStateContract = c.router({
  get: {
    method: "GET",
    path: "/api/test/telegram-state",
    query: testTelegramStateQuerySchema,
    responses: {
      200: testTelegramStateResponseSchema,
      400: testTelegramStateErrorSchema,
      404: z.string(),
    },
    summary: "Inspect Telegram E2E test state",
  },
});

export type TestTelegramStateContract = typeof testTelegramStateContract;
export type TestTelegramStateResponse = z.infer<
  typeof testTelegramStateResponseSchema
>;
