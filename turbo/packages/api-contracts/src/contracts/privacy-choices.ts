import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const PRIVACY_POLICY_VERSION = "2026-09-10";

const consentSchema = z.enum(["granted", "denied", "unknown"]);
export const privacyPurposesSchema = z
  .object({
    saleSharing: consentSchema,
    advertising: consentSchema,
    marketingAnalytics: consentSchema,
  })
  .strict();

export const privacyChoiceUpdateSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("gpc") }).strict(),
  z
    .object({
      source: z.literal("explicit"),
      policyVersion: z.literal(PRIVACY_POLICY_VERSION),
      expectedRevision: z.uuid().nullable(),
      purposes: privacyPurposesSchema,
    })
    .strict(),
]);

export const privacyChoiceStateSchema = z.object({
  subjectId: z.uuid().nullable(),
  revision: z.uuid().nullable(),
  purposes: privacyPurposesSchema,
  source: z.enum(["explicit", "gpc"]).nullable(),
  policyVersion: z.string(),
  updatedAt: z.iso.datetime().nullable(),
  advertisingAllowed: z.boolean(),
  marketingAnalyticsAllowed: z.boolean(),
});

export const anonymousPrivacyTokenSchema = z
  .string()
  .regex(/^pc_[a-f0-9]{64}$/u);
const headers = authHeadersSchema.extend({ "sec-gpc": z.string().optional() });
const responses = {
  200: privacyChoiceStateSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
  503: apiErrorSchema,
};
const c = initContract();

export const privacyChoicesContract = c.router({
  createAnonymous: {
    method: "POST",
    path: "/api/privacy-choices/anonymous",
    headers,
    body: z.object({ choice: privacyChoiceUpdateSchema.optional() }).strict(),
    responses: {
      ...responses,
      200: z.object({
        token: anonymousPrivacyTokenSchema,
        state: privacyChoiceStateSchema,
      }),
    },
    summary: "Create a necessary, anonymous privacy preference receipt",
  },
  getAnonymous: {
    method: "GET",
    path: "/api/privacy-choices/anonymous",
    headers,
    responses,
    summary: "Read privacy choices using a privacy-only bearer receipt",
  },
  updateAnonymous: {
    method: "PUT",
    path: "/api/privacy-choices/anonymous",
    headers,
    body: privacyChoiceUpdateSchema,
    responses,
    summary: "Save anonymous privacy choices without login or identification",
  },
  get: {
    method: "GET",
    path: "/api/privacy-choices",
    headers,
    responses,
    summary: "Read the signed-in person's privacy choices across organizations",
  },
  update: {
    method: "PUT",
    path: "/api/privacy-choices",
    headers,
    body: privacyChoiceUpdateSchema,
    responses,
    summary: "Save the signed-in person's privacy choices",
  },
  associate: {
    method: "POST",
    path: "/api/privacy-choices/associate",
    headers,
    body: z.object({ anonymousToken: anonymousPrivacyTokenSchema }).strict(),
    responses,
    summary: "Associate the latest anonymous choice with the signed-in person",
  },
});

export type PrivacyPurposes = z.infer<typeof privacyPurposesSchema>;
export type PrivacyChoiceUpdate = z.infer<typeof privacyChoiceUpdateSchema>;
export type PrivacyChoiceState = z.infer<typeof privacyChoiceStateSchema>;
