import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const insightAgentSchema = z.object({
  agentName: z.string(),
  agentId: z.string().nullable(),
  runs: z.number(),
  credits: z.number(),
});

const insightServiceSchema = z.object({
  domain: z.string(),
  calls: z.number(),
  agentNames: z.array(z.string()),
});

export const insightPermissionSchema = z
  .object({
    label: z.string(),
    connectorSlug: z.string().optional(),
    // TODO(#23840): Remove after legacy Insights clients have drained.
    connectorType: z.string().optional(),
    allowed: z.number(),
    denied: z.number(),
    agentNames: z.array(z.string()),
  })
  .superRefine((permission, context) => {
    if (
      permission.connectorSlug !== undefined &&
      permission.connectorType !== undefined &&
      permission.connectorSlug !== permission.connectorType
    ) {
      context.addIssue({
        code: "custom",
        path: ["connectorSlug"],
        message: "connectorSlug and connectorType must match",
      });
    }
  })
  .overwrite((permission) => {
    const connectorSlug = permission.connectorSlug ?? permission.connectorType;
    if (connectorSlug === undefined) {
      return permission;
    }
    return {
      ...permission,
      connectorSlug,
      connectorType: connectorSlug,
    };
  });

const insightTopTaskSchema = z.object({
  name: z.string(),
  count: z.number(),
});

const insightMemberCreditsSchema = z.object({
  name: z.string(),
  credits: z.number(),
  agentNames: z.array(z.string()).optional(),
  agentCredits: z.record(z.string(), z.number()).optional(),
});

const insightDayAutomationSchema = z.object({
  automationId: z.string(),
  automationName: z.string(),
  automationDescription: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
});

const insightDayChatSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
});

const dayInsightSchema = z.object({
  date: z.string(),
  agents: z.array(insightAgentSchema).default([]),
  creditsUsed: z.number().default(0),
  creditBalance: z.number().default(0),
  teamUsage: z.array(insightMemberCreditsSchema).default([]),
  topTask: insightTopTaskSchema.nullable().default(null),
  services: z.array(insightServiceSchema).default([]),
  permissions: z.array(insightPermissionSchema).default([]),
  automations: z.array(insightDayAutomationSchema).default([]),
  chats: z.array(insightDayChatSchema).default([]),
});

const insightsResponseSchema = z.object({
  days: z.array(dayInsightSchema),
  totalCredits: z.number(),
  totalRuns: z.number(),
  lastUpdated: z.string().nullable(),
});

export const zeroInsightsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/insights",
    headers: authHeadersSchema,
    query: z.object({
      days: z.coerce.number().optional(),
    }),
    responses: {
      200: insightsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Get daily insights for the authenticated org",
  },
});

export type ZeroInsightsContract = typeof zeroInsightsContract;
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;
export type DayInsight = z.infer<typeof dayInsightSchema>;
