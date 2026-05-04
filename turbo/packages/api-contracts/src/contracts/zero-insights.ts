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

const insightPermissionSchema = z.object({
  label: z.string(),
  connectorType: z.string().optional(),
  allowed: z.number(),
  denied: z.number(),
  agentNames: z.array(z.string()),
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

const insightDayScheduleSchema = z.object({
  scheduleId: z.string(),
  scheduleName: z.string(),
  scheduleDescription: z.string().nullable(),
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
  schedules: z.array(insightDayScheduleSchema).default([]),
  chats: z.array(insightDayChatSchema).default([]),
});

const insightsResponseSchema = z.object({
  days: z.array(dayInsightSchema),
  totalCredits: z.number(),
  totalRuns: z.number(),
  lastUpdated: z.string().nullable(),
});

const insightsRangeResponseSchema = z.object({
  minDate: z.string().nullable(),
  maxDate: z.string().nullable(),
  totalDays: z.number(),
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

export const zeroInsightsRangeContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/insights/range",
    headers: authHeadersSchema,
    responses: {
      200: insightsRangeResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Get available date range for org insights",
  },
});

export type ZeroInsightsContract = typeof zeroInsightsContract;
export type ZeroInsightsRangeContract = typeof zeroInsightsRangeContract;
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;
export type InsightsRangeResponse = z.infer<typeof insightsRangeResponseSchema>;
export type DayInsight = z.infer<typeof dayInsightSchema>;
