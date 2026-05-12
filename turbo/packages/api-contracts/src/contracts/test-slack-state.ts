import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testSlackStateErrorSchema = z.object({
  error: z.string(),
});

export const testSlackStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

const nullableDateStringSchema = z.string().nullable();

export const testSlackStateResponseSchema = z.object({
  installation: z
    .object({
      slackWorkspaceId: z.string(),
      slackWorkspaceName: z.string().nullable(),
      orgId: z.string().nullable(),
      botUserId: z.string(),
      installedByUserId: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  connections: z.array(
    z.object({
      id: z.string(),
      slackUserId: z.string(),
      vm0UserId: z.string(),
      dmWelcomeSent: z.boolean(),
      createdAt: z.string(),
    }),
  ),
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
  default_compose_version: z
    .object({
      id: z.string(),
      content_keys: z.array(z.string()),
    })
    .nullable(),
  resolved_slack_api_url: z.string().nullable(),
  mock_calls: z.array(
    z.object({
      method: z.string(),
      teamId: z.string().nullable(),
      channelId: z.string().nullable(),
      bodyJson: z.unknown(),
      createdAt: nullableDateStringSchema,
    }),
  ),
});

export const testSlackStateContract = c.router({
  get: {
    method: "GET",
    path: "/api/test/slack-state",
    query: z.object({
      team_id: z.string().optional(),
    }),
    responses: {
      200: testSlackStateResponseSchema,
      400: testSlackStateErrorSchema,
      404: z.string(),
    },
    summary: "Read Slack e2e diagnostic state for a test workspace",
  },
  delete: {
    method: "DELETE",
    path: "/api/test/slack-state",
    query: z.object({
      team_id: z.string().optional(),
    }),
    responses: {
      200: testSlackStateDeleteResponseSchema,
      400: testSlackStateErrorSchema,
      404: z.string(),
    },
    summary: "Clear Slack e2e diagnostic state for a test workspace",
  },
});

export type TestSlackStateContract = typeof testSlackStateContract;
export type TestSlackStateDeleteResponse = z.infer<
  typeof testSlackStateDeleteResponseSchema
>;
export type TestSlackStateResponse = z.infer<
  typeof testSlackStateResponseSchema
>;
