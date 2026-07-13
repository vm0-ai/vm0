import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const teamsMockBodySchema = z.record(z.string(), z.unknown()).optional();
const teamsMockOkSchema = z.object({ ok: z.literal(true) });
const teamsMockTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
});
const teamsMockActivityResponseSchema = z.object({
  id: z.string(),
});
const teamsMockConversationResponseSchema = z.object({
  id: z.string(),
});
const teamsMockGraphMessagesResponseSchema = z.object({
  value: z.array(z.unknown()),
});

export const testTeamsMockConversationPathParamsSchema = z.object({
  conversationId: z.string(),
});

export const testTeamsMockActivityPathParamsSchema =
  testTeamsMockConversationPathParamsSchema.extend({
    activityId: z.string(),
  });

export const testTeamsMockReactionPathParamsSchema =
  testTeamsMockActivityPathParamsSchema.extend({
    reactionType: z.string(),
  });

export const testTeamsMockGraphMessagesPathParamsSchema = z.object({
  teamId: z.string(),
  channelId: z.string(),
});

export const testTeamsMockGraphMessagePathParamsSchema =
  testTeamsMockGraphMessagesPathParamsSchema.extend({
    messageId: z.string(),
  });

export const testTeamsMockGraphUserPathParamsSchema = z.object({
  userId: z.string(),
});

export const testTeamsMockContract = c.router({
  token: {
    method: "POST",
    path: "/api/test/teams-mock/token",
    body: teamsMockBodySchema,
    responses: {
      200: teamsMockTokenResponseSchema,
      404: z.string(),
    },
    summary: "Mock Microsoft OAuth token endpoint for Teams e2e tests",
  },
  createConversation: {
    method: "POST",
    path: "/api/test/teams-mock/service/v3/conversations",
    body: teamsMockBodySchema,
    responses: {
      200: teamsMockConversationResponseSchema,
      404: z.string(),
    },
    summary: "Mock Bot Framework create conversation",
  },
  sendActivity: {
    method: "POST",
    path: "/api/test/teams-mock/service/v3/conversations/:conversationId/activities",
    pathParams: testTeamsMockConversationPathParamsSchema,
    body: teamsMockBodySchema,
    responses: {
      200: teamsMockActivityResponseSchema,
      404: z.string(),
    },
    summary: "Mock Bot Framework send activity",
  },
  replyActivity: {
    method: "POST",
    path: "/api/test/teams-mock/service/v3/conversations/:conversationId/activities/:activityId",
    pathParams: testTeamsMockActivityPathParamsSchema,
    body: teamsMockBodySchema,
    responses: {
      200: teamsMockActivityResponseSchema,
      404: z.string(),
    },
    summary: "Mock Bot Framework reply activity",
  },
  putReaction: {
    method: "PUT",
    path: "/api/test/teams-mock/service/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType",
    pathParams: testTeamsMockReactionPathParamsSchema,
    body: teamsMockBodySchema,
    responses: {
      200: teamsMockOkSchema,
      404: z.string(),
    },
    summary: "Mock Bot Framework add reaction",
  },
  deleteReaction: {
    method: "DELETE",
    path: "/api/test/teams-mock/service/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType",
    pathParams: testTeamsMockReactionPathParamsSchema,
    body: teamsMockBodySchema,
    responses: {
      200: teamsMockOkSchema,
      404: z.string(),
    },
    summary: "Mock Bot Framework delete reaction",
  },
  graphMessages: {
    method: "GET",
    path: "/api/test/teams-mock/graph/teams/:teamId/channels/:channelId/messages",
    pathParams: testTeamsMockGraphMessagesPathParamsSchema,
    responses: {
      200: teamsMockGraphMessagesResponseSchema,
      404: z.string(),
    },
    summary: "Mock Microsoft Graph channel message list",
  },
  graphMessage: {
    method: "GET",
    path: "/api/test/teams-mock/graph/teams/:teamId/channels/:channelId/messages/:messageId",
    pathParams: testTeamsMockGraphMessagePathParamsSchema,
    responses: {
      200: z.unknown(),
      404: z.string(),
    },
    summary: "Mock Microsoft Graph channel message",
  },
  graphReplies: {
    method: "GET",
    path: "/api/test/teams-mock/graph/teams/:teamId/channels/:channelId/messages/:messageId/replies",
    pathParams: testTeamsMockGraphMessagePathParamsSchema,
    responses: {
      200: teamsMockGraphMessagesResponseSchema,
      404: z.string(),
    },
    summary: "Mock Microsoft Graph channel message replies",
  },
  graphUser: {
    method: "GET",
    path: "/api/test/teams-mock/graph/users/:userId",
    pathParams: testTeamsMockGraphUserPathParamsSchema,
    responses: {
      200: z.unknown(),
      404: z.string(),
    },
    summary: "Mock Microsoft Graph user lookup",
  },
});

export type TestTeamsMockContract = typeof testTeamsMockContract;
