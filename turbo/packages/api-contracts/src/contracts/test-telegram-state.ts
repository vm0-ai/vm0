import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTelegramStateQuerySchema = z.object({
  bot_id: z.string().optional(),
});

export const testTelegramStateErrorSchema = z.object({
  error: z.string(),
});

export const testTelegramStateSeedBodySchema = z
  .object({
    bot_id: z.string().optional(),
    telegram_user_id: z.string().optional(),
    bot_username: z.string().optional(),
    webhook_secret: z.string().optional(),
    email: z.string().optional(),
    seed_link: z.boolean().optional(),
  })
  .passthrough();

export const testTelegramStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-installation",
      "seed-org-default-agent",
      "seed-official-user-link",
      "seed-user-link",
      "seed-user-agent-preference",
      "seed-agent-run-callback",
      "seed-thread-session",
      "update-run",
      "get-run",
      "find-thread-session",
      "delete-fixture",
    ]),
  })
  .passthrough();

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
  messages: z.array(z.unknown()),
  official_messages: z.array(z.unknown()),
  thread_sessions: z.array(z.unknown()),
});

export const testTelegramStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const testTelegramStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testTelegramStateSeedResponseSchema = z.object({
  ok: z.literal(true),
  bot_id: z.string(),
  org_id: z.string(),
  vm0_user_id: z.string(),
  user_link_id: z.string().nullable(),
  default_agent_id: z.string(),
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
  delete: {
    method: "DELETE",
    path: "/api/test/telegram-state",
    query: testTelegramStateQuerySchema,
    responses: {
      200: testTelegramStateDeleteResponseSchema,
      400: testTelegramStateErrorSchema,
      404: z.string(),
    },
    summary: "Delete Telegram E2E test state",
  },
  post: {
    method: "POST",
    path: "/api/test/telegram-state",
    body: testTelegramStateSeedBodySchema,
    responses: {
      200: testTelegramStateSeedResponseSchema,
      400: testTelegramStateErrorSchema,
      404: z.string(),
    },
    summary: "Seed Telegram E2E test state",
  },
  action: {
    method: "POST",
    path: "/api/test/telegram-state/action",
    body: testTelegramStateActionBodySchema,
    responses: {
      200: testTelegramStateActionResponseSchema,
      400: testTelegramStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate Telegram API test state",
  },
});

export type TestTelegramStateContract = typeof testTelegramStateContract;
export type TestTelegramStateResponse = z.infer<
  typeof testTelegramStateResponseSchema
>;
export type TestTelegramStateSeedBody = z.infer<
  typeof testTelegramStateSeedBodySchema
>;
export type TestTelegramStateSeedResponse = z.infer<
  typeof testTelegramStateSeedResponseSchema
>;
export type TestTelegramStateActionBody = z.infer<
  typeof testTelegramStateActionBodySchema
>;
export type TestTelegramStateActionResponse = z.infer<
  typeof testTelegramStateActionResponseSchema
>;
