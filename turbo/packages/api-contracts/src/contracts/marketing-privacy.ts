import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const MARKETING_PRIVACY_RECEIPT_KEY = "marketing_privacy_receipt";
export const IMPACT_PRIVACY_RECEIPT_KEY = "impact_privacy_receipt";
export const privacyCaptureContextSchema = z
  .object({
    subjectId: z.uuid(),
    revision: z.uuid(),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type PrivacyCaptureContext = z.infer<typeof privacyCaptureContextSchema>;
export const marketingPrivacyReasonSchema = z.enum([
  "missing_context",
  "unverified_context",
  "subject_mismatch",
  "event_before_capture",
  "purpose_denied",
  "withdrawn",
  "unavailable",
]);
export type MarketingPrivacyReason = z.infer<
  typeof marketingPrivacyReasonSchema
>;
export const marketingPrivacyRequestSchema = z
  .object({
    receiptId: z.uuid(),
    userId: z.string().min(1).max(128),
    eventTime: z.iso.datetime(),
    purpose: z.enum(["advertising", "marketingAnalytics"]),
  })
  .strict();
export type MarketingPrivacyRequest = z.infer<
  typeof marketingPrivacyRequestSchema
>;
export const marketingPrivacyDecisionSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true), reason: z.null() }),
  z.object({ allowed: z.literal(false), reason: marketingPrivacyReasonSchema }),
]);
export type MarketingPrivacyDecision = z.infer<
  typeof marketingPrivacyDecisionSchema
>;
const c = initContract();
export const marketingPrivacyContract = c.router({
  authorize: {
    method: "POST",
    path: "/api/internal/marketing/privacy/authorize",
    headers: authHeadersSchema,
    body: marketingPrivacyRequestSchema,
    responses: {
      200: marketingPrivacyDecisionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Check event-time and current privacy evidence for a marketing sender",
  },
});
