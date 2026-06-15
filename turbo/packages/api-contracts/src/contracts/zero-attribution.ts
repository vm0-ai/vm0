import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Canonical acquisition source-type taxonomy. Single source of truth shared by
// the web classifier (apps/web), the app capture layer (apps/platform), and the
// signup contract below, so the enum can't drift across the three.
export const SOURCE_TYPES = [
  "paid",
  "organic_search",
  "referral",
  "direct",
  "internal",
  "unknown",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

// First-party, root-domain (.vm0.ai) cookie carrying first-touch acquisition
// attribution across the www.vm0.ai -> app.vm0.ai subdomain hop. Written by the
// marketing site (consent-gated), read by the app on first load.
export const ACQUISITION_ATTRIBUTION_COOKIE = "vm0_attribution";

export const adAttributionMetadataSchema = z
  .object({
    source_type: z.enum(SOURCE_TYPES).optional(),
    referrer_domain: z.string().min(1).max(253).optional(),
    landing_host: z.string().min(1).max(253).optional(),
    landing_path: z.string().min(1).max(500).optional(),
    vm0_source: z.string().min(1).max(100).optional(),
    utm_source: z.string().min(1).max(100).optional(),
    utm_medium: z.string().min(1).max(100).optional(),
    utm_campaign: z.string().min(1).max(200).optional(),
    utm_content: z.string().min(1).max(200).optional(),
    utm_term: z.string().min(1).max(200).optional(),
    vm0_experiment: z.string().min(1).max(100).optional(),
    vm0_variant: z.string().min(1).max(100).optional(),
    lp_variant: z.string().min(1).max(100).optional(),
    gclid: z.string().min(1).max(200).optional(),
    gbraid: z.string().min(1).max(200).optional(),
    wbraid: z.string().min(1).max(200).optional(),
    gclid_present: z.literal("true").optional(),
    gbraid_present: z.literal("true").optional(),
    wbraid_present: z.literal("true").optional(),
  })
  .strict();

const recordSignupAttributionRequestSchema = z.object({
  attribution: adAttributionMetadataSchema,
});

const recordSignupAttributionResponseSchema = z.object({
  recorded: z.boolean(),
});

export const zeroAttributionContract = c.router({
  recordSignup: {
    method: "POST",
    path: "/api/zero/attribution/signup",
    headers: authHeadersSchema,
    body: recordSignupAttributionRequestSchema,
    responses: {
      200: recordSignupAttributionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Record first-touch signup attribution on the current user",
  },
});

export type AdAttributionMetadata = z.infer<typeof adAttributionMetadataSchema>;
export type RecordSignupAttributionRequest = z.infer<
  typeof recordSignupAttributionRequestSchema
>;
export type RecordSignupAttributionResponse = z.infer<
  typeof recordSignupAttributionResponseSchema
>;
export type ZeroAttributionContract = typeof zeroAttributionContract;
