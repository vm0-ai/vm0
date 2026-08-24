import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testTeamsStateErrorSchema = z.object({
  error: z.string(),
});

export const testTeamsStateDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export const testTeamsStatePostBodySchema = z.object({
  tenant_id: z.string().optional(),
  tenant_name: z.string().nullable().optional(),
  team_id: z.string().nullable().optional(),
  team_name: z.string().nullable().optional(),
  service_url: z.string().optional(),
  bot_id: z.string().nullable().optional(),
  bot_name: z.string().nullable().optional(),
  teams_user_id: z.string().nullable().optional(),
  teams_aad_object_id: z.string().nullable().optional(),
  teams_user_display_name: z.string().nullable().optional(),
  teams_user_principal_name: z.string().nullable().optional(),
  org_id: z.string().optional(),
  user_id: z.string().optional(),
  email: z.string().optional(),
  installation_org_id: z.string().nullable().optional(),
  seed_connection: z.boolean().optional(),
  delete_connection: z.boolean().optional(),
  seed_default_agent: z.boolean().optional(),
  default_agent_name: z.string().optional(),
  default_agent_display_name: z.string().nullable().optional(),
});

export const testTeamsStatePostResponseSchema = z.object({
  ok: z.literal(true),
  tenant_id: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  connection_id: z.string().nullable(),
  default_agent_id: z.string().nullable(),
});

const nullableDateStringSchema = z.string().nullable();

export const testTeamsStateResponseSchema = z.object({
  installation: z
    .object({
      teamsTenantId: z.string(),
      teamsTenantName: z.string().nullable(),
      teamsTeamId: z.string().nullable(),
      teamsTeamName: z.string().nullable(),
      teamsAppId: z.string().nullable(),
      botId: z.string().nullable(),
      botName: z.string().nullable(),
      serviceUrl: z.string().nullable(),
      orgId: z.string().nullable(),
      installedByUserId: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  connections: z.array(
    z.object({
      id: z.string(),
      teamsUserId: z.string().nullable(),
      teamsAadObjectId: z.string().nullable(),
      userId: z.string(),
      teamsUserDisplayName: z.string().nullable(),
      teamsUserPrincipalName: z.string().nullable(),
      dmWelcomeSent: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  routes: z.array(
    z.object({
      id: z.string(),
      connectionId: z.string(),
      conversationId: z.string(),
      threadId: z.string(),
      userId: z.string(),
      chatThreadId: z.string(),
      createdAt: z.string(),
    }),
  ),
  recent_runs: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      createdAt: z.string(),
      triggerSource: z.string().nullable(),
      chatThreadId: z.string().nullable(),
      userId: z.string(),
      error: z.string().nullable(),
      promptPreview: z.string().nullable(),
    }),
  ),
  recent_callbacks: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      status: z.string(),
      internalKind: z.string().nullable(),
      attempts: z.number(),
      lastError: z.string().nullable(),
      createdAt: z.string(),
      lastAttemptAt: nullableDateStringSchema,
      deliveredAt: nullableDateStringSchema,
      payload: z.unknown(),
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
});

export const testTeamsStateContract = c.router({
  get: {
    method: "GET",
    path: "/api/test/teams-state",
    query: z.object({
      tenant_id: z.string().optional(),
      org_id: z.string().optional(),
    }),
    responses: {
      200: testTeamsStateResponseSchema,
      400: testTeamsStateErrorSchema,
      404: z.string(),
    },
    summary: "Read Teams API integration test state",
  },
  post: {
    method: "POST",
    path: "/api/test/teams-state",
    body: testTeamsStatePostBodySchema,
    responses: {
      200: testTeamsStatePostResponseSchema,
      400: testTeamsStateErrorSchema,
      404: z.string(),
    },
    summary: "Seed Teams API integration test state",
  },
  delete: {
    method: "DELETE",
    path: "/api/test/teams-state",
    query: z.object({
      tenant_id: z.string().optional(),
      org_id: z.string().optional(),
    }),
    responses: {
      200: testTeamsStateDeleteResponseSchema,
      400: testTeamsStateErrorSchema,
      404: z.string(),
    },
    summary: "Clear Teams API integration test state",
  },
});

export type TestTeamsStateContract = typeof testTeamsStateContract;
export type TestTeamsStatePostBody = z.infer<
  typeof testTeamsStatePostBodySchema
>;
export type TestTeamsStatePostResponse = z.infer<
  typeof testTeamsStatePostResponseSchema
>;
export type TestTeamsStateResponse = z.infer<
  typeof testTeamsStateResponseSchema
>;
