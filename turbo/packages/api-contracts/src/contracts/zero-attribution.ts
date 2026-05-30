import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const adAttributionMetadataSchema = z
  .object({
    vm0_source: z.string().min(1).max(100).optional(),
    utm_source: z.string().min(1).max(100).optional(),
    utm_medium: z.string().min(1).max(100).optional(),
    utm_campaign: z.string().min(1).max(200).optional(),
    utm_content: z.string().min(1).max(200).optional(),
    utm_term: z.string().min(1).max(200).optional(),
    vm0_experiment: z.string().min(1).max(100).optional(),
    vm0_variant: z.string().min(1).max(100).optional(),
    lp_variant: z.string().min(1).max(100).optional(),
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
