import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testTelegramStateQuerySchema = z.object({
  bot_id: z.string().optional(),
});

export const testTelegramStateErrorSchema = z.object({
  error: z.string(),
});

export const testTelegramStateBadRequestSchema = z.union([
  testTelegramStateErrorSchema,
  apiErrorSchema,
]);

export const testTelegramStateSeedBodySchema = z.object({
  bot_id: z.string().optional(),
  telegram_user_id: z.string().optional(),
  bot_username: z.string().optional(),
  webhook_secret: z.string().optional(),
  email: z.string().optional(),
  seed_link: z.boolean().optional(),
  seed_message: z.boolean().optional(),
  seed_telegram_run: z.boolean().optional(),
  seed_slack_run: z.boolean().optional(),
});

export const testTelegramStateComposeVersionSchema = z.object({
  id: z.string(),
  content_keys: z.array(z.string()),
});

const nullableDateStringSchema = z.string().nullable();

export const testTelegramStateMockCallSchema = z.object({
  method: z.string(),
  botToken: z.string().nullable(),
  chatId: z.string().nullable(),
  body: z.string(),
  bodyJson: z.unknown(),
  createdAt: nullableDateStringSchema,
});

export const testTelegramStateResponseSchema = z.object({
  installation: z
    .object({
      telegramBotId: z.string(),
      botUsername: z.string().nullable(),
      orgId: z.string(),
      ownerUserId: z.string(),
      defaultComposeId: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
  links: z.array(
    z.object({
      id: z.string(),
      telegramUserId: z.string(),
      vm0UserId: z.string(),
      dmWelcomeSent: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  message_count: z.number(),
  recent_runs: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      createdAt: z.string(),
      triggerSource: z.string().nullable(),
      userId: z.string(),
      error: z.string().nullable(),
      promptPreview: z.string().nullable(),
    }),
  ),
  org_metadata: z
    .object({
      orgId: z.string(),
      defaultAgentId: z.string().nullable(),
      credits: z.number(),
      tier: z.string(),
    })
    .nullable(),
  default_agent: z
    .object({
      id: z.string(),
      name: z.string(),
      orgId: z.string(),
    })
    .nullable(),
  default_compose: z
    .object({
      id: z.string(),
      name: z.string(),
      headVersionId: z.string().nullable(),
    })
    .nullable(),
  default_compose_version: testTelegramStateComposeVersionSchema.nullable(),
  resolved_telegram_api_url: z.string().nullable(),
  mock_calls: z.array(testTelegramStateMockCallSchema),
});

export const testTelegramStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const testTelegramStateSeedResponseSchema = z.object({
  ok: z.literal(true),
  bot_id: z.string(),
  org_id: z.string(),
  vm0_user_id: z.string(),
  user_link_id: z.string().nullable(),
  default_agent_id: z.string(),
  message_id: z.string().nullable(),
  telegram_run_id: z.string().nullable(),
  slack_run_id: z.string().nullable(),
});

export const testTelegramStateContract = c.router({
  get: {
    method: "GET",
    path: "/api/test/telegram-state",
    query: testTelegramStateQuerySchema,
    responses: {
      200: testTelegramStateResponseSchema,
      400: testTelegramStateBadRequestSchema,
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
      400: testTelegramStateBadRequestSchema,
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
      400: testTelegramStateBadRequestSchema,
      404: z.string(),
    },
    summary: "Seed Telegram E2E test state",
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
