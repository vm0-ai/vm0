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

/**
 * Phase-A endpoint fallback for already-delivered links and old App bundles.
 * Phase B removes it after #30264's released zero-request observation gate and
 * replacement App version floor close the retained-link/client window.
 */
export const emailMorningBriefUnsubscribeContract = c.router({
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
