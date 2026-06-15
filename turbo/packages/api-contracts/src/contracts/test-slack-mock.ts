import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const SLACK_E2E_FIXTURES = {
  botUserId: "U_E2E_BOT",
  userUserId: "U_E2E_USER",
  botId: "B_E2E_BOT",
  teamId: "T_E2E",
  appId: "A_E2E_APP",
  channelId: "C_E2E_MOCK",
  botToken: "xoxb-e2e-test-bot-token",
  teamName: "E2E Test Team",
} as const;

export const SLACK_E2E_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
] as const;

const slackMockRequestBodySchema = z.unknown().optional();
const slackMockNotFoundSchema = z.string();

export const testSlackMockOkResponseSchema = z.object({
  ok: z.literal(true),
});

export const testSlackMockAuthTestResponseSchema =
  testSlackMockOkResponseSchema.extend({
    url: z.string(),
    team: z.string(),
    user: z.string(),
    team_id: z.string(),
    user_id: z.string(),
    bot_id: z.string(),
  });

export const testSlackMockOauthAccessResponseSchema =
  testSlackMockOkResponseSchema.extend({
    access_token: z.string(),
    token_type: z.literal("bot"),
    scope: z.string(),
    bot_user_id: z.string(),
    app_id: z.string(),
    team: z.object({
      id: z.string(),
      name: z.string(),
    }),
    enterprise: z.null(),
    authed_user: z.object({
      id: z.string(),
      scope: z.string(),
      access_token: z.string(),
      token_type: z.literal("user"),
    }),
  });

export const testSlackMockChatPostMessageResponseSchema =
  testSlackMockOkResponseSchema.extend({
    channel: z.string(),
    ts: z.string(),
    message: z.object({
      ts: z.string(),
      text: z.string(),
    }),
  });

export const testSlackMockChatPostEphemeralResponseSchema =
  testSlackMockOkResponseSchema.extend({
    message_ts: z.string(),
  });

export const testSlackMockConversationsOpenResponseSchema =
  testSlackMockOkResponseSchema.extend({
    channel: z.object({
      id: z.string(),
    }),
  });

export const testSlackMockConversationMessagesResponseSchema =
  testSlackMockOkResponseSchema.extend({
    messages: z.array(z.unknown()),
    has_more: z.literal(false),
  });

export const testSlackMockUsersInfoResponseSchema =
  testSlackMockOkResponseSchema.extend({
    user: z.object({
      id: z.string(),
      name: z.string(),
      real_name: z.string(),
      tz: z.string(),
      tz_label: z.string(),
      profile: z.object({
        display_name: z.string(),
        real_name: z.string(),
        email: z.string(),
      }),
    }),
  });

export const testSlackMockContract = c.router({
  assistantThreadsSetStatus: {
    method: "POST",
    path: "/api/test/slack-mock/assistant.threads.setStatus",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockOkResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack assistant.threads.setStatus for e2e tests",
  },
  authTest: {
    method: "POST",
    path: "/api/test/slack-mock/auth.test",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockAuthTestResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack auth.test for e2e tests",
  },
  chatPostEphemeral: {
    method: "POST",
    path: "/api/test/slack-mock/chat.postEphemeral",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockChatPostEphemeralResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack chat.postEphemeral for e2e tests",
  },
  chatPostMessage: {
    method: "POST",
    path: "/api/test/slack-mock/chat.postMessage",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockChatPostMessageResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack chat.postMessage for e2e tests",
  },
  conversationsHistory: {
    method: "POST",
    path: "/api/test/slack-mock/conversations.history",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockConversationMessagesResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack conversations.history for e2e tests",
  },
  conversationsOpen: {
    method: "POST",
    path: "/api/test/slack-mock/conversations.open",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockConversationsOpenResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack conversations.open for e2e tests",
  },
  conversationsReplies: {
    method: "POST",
    path: "/api/test/slack-mock/conversations.replies",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockConversationMessagesResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack conversations.replies for e2e tests",
  },
  oauthV2Access: {
    method: "POST",
    path: "/api/test/slack-mock/oauth.v2.access",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockOauthAccessResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack oauth.v2.access for e2e tests",
  },
  usersInfo: {
    method: "POST",
    path: "/api/test/slack-mock/users.info",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockUsersInfoResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack users.info for e2e tests",
  },
  viewsPublish: {
    method: "POST",
    path: "/api/test/slack-mock/views.publish",
    body: slackMockRequestBodySchema,
    responses: {
      200: testSlackMockOkResponseSchema,
      404: slackMockNotFoundSchema,
    },
    summary: "Mock Slack views.publish for e2e tests",
  },
});

export type TestSlackMockContract = typeof testSlackMockContract;
export type TestSlackMockUsersInfoResponse = z.infer<
  typeof testSlackMockUsersInfoResponseSchema
>;
