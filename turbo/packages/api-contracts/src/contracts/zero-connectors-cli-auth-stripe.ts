import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorResponseSchema } from "./connector-schemas";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const cliAuthStripeModeSchema = z.enum(["test", "live"]);

const cliAuthStripeStartResponseSchema = z.object({
  sessionToken: z.string(),
  type: z.literal("stripe"),
  status: z.literal("pending"),
  mode: cliAuthStripeModeSchema,
  browserUrl: z.url(),
  verificationCode: z.string().min(1),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const cliAuthStripeCompleteResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    errorMessage: z.string().nullable(),
  }),
  z.object({
    status: z.literal("complete"),
    connector: connectorResponseSchema,
  }),
]);

/**
 * Zero contract for CLI auth for Stripe.
 * Runs Stripe's browser confirmation flow in a managed sandbox and imports the
 * resulting CLI key as the Stripe API-token connector secret.
 */
export const zeroCliAuthStripeContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/connectors/stripe/cli-auth/sessions",
    headers: authHeadersSchema,
    body: z.object({ mode: cliAuthStripeModeSchema }),
    responses: {
      200: cliAuthStripeStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start CLI auth for Stripe in a sandbox",
  },
  complete: {
    method: "POST",
    path: "/api/zero/connectors/stripe/cli-auth/sessions/complete",
    headers: authHeadersSchema,
    body: z.object({ sessionToken: z.string().min(1) }),
    responses: {
      200: cliAuthStripeCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Complete CLI auth for Stripe and import the Stripe token",
  },
});

export type ZeroCliAuthStripeContract = typeof zeroCliAuthStripeContract;
