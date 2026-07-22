import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const emailMorningBriefUnsubscribeQuerySchema = z.object({
  token: z.string().optional(),
});

export const emailMorningBriefUnsubscribeResponseSchema = z.object({
  unsubscribed: z.literal(true),
});

export const emailMorningBriefUnsubscribeErrorSchema = z.object({
  error: z.string(),
});

export const emailMorningBriefUnsubscribeContract = c.router({
  get: {
    method: "GET",
    path: "/api/email/morning-brief/unsubscribe",
    query: emailMorningBriefUnsubscribeQuerySchema,
    responses: {
      302: c.noBody(),
      400: emailMorningBriefUnsubscribeErrorSchema,
    },
    summary: "Redirect to the app Morning Brief unsubscribe page",
  },
  unsubscribe: {
    method: "POST",
    path: "/api/email/morning-brief/unsubscribe",
    query: emailMorningBriefUnsubscribeQuerySchema,
    body: z.undefined(),
    responses: {
      200: emailMorningBriefUnsubscribeResponseSchema,
      400: emailMorningBriefUnsubscribeErrorSchema,
    },
    summary: "One-click List-Unsubscribe for the Morning Brief",
  },
});

export type EmailMorningBriefUnsubscribeContract =
  typeof emailMorningBriefUnsubscribeContract;
