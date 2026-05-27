import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const autoRechargeSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().nullable(),
  amount: z.number().nullable(),
});

const creditExpirySchema = z.object({
  expiringNextCycle: z.number(),
  nextExpiryDate: z.string().nullable(),
});

const creditBreakdownSegmentSchema = z.object({
  category: z.enum(["plan", "free", "promotional", "payAsYouGo"]),
  label: z.string(),
  credits: z.number(),
  // Only set on `plan` segments. Lets the UI decide whether a segment
  // represents the current plan or leftover credits from a previous plan
  // without round-tripping through the `label` string.
  tier: z.enum(["pro", "team"]).optional(),
});

const creditGrantSchema = z.object({
  id: z.string(),
  source: z.string(),
  label: z.string(),
  amount: z.number(),
  remaining: z.number(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const billingStatusResponseSchema = z.object({
  tier: z.string(),
  credits: z.number(),
  subscriptionStatus: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  hasSubscription: z.boolean(),
  autoRecharge: autoRechargeSchema,
  creditExpiry: creditExpirySchema,
  creditBreakdown: z.array(creditBreakdownSegmentSchema),
  creditGrants: z.array(creditGrantSchema),
});

const checkoutResponseSchema = z.object({
  url: z.string(),
});

const checkoutCompleteResponseSchema = z.object({
  completed: z.boolean(),
});

const portalResponseSchema = z.object({
  url: z.string(),
});

const redeemResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    checkoutUrl: z.string().url(),
  }),
  z.object({
    status: z.literal("already_granted"),
  }),
  z.object({
    status: z.literal("processing"),
  }),
  z.object({
    status: z.literal("error"),
    reason: z.enum([
      "campaign_misconfigured",
      "admin_required",
      "billing_unavailable",
    ]),
  }),
]);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const checkoutRequestSchema = z.object({
  tier: z.enum(["pro", "team"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  trialDays: z.literal(7).optional(),
});

const checkoutCompleteRequestSchema = z.object({
  sessionId: z.string().min(1),
});

const creditCheckoutRequestSchema = z
  .object({
    credits: z.number().int().min(1000).max(10_000_000),
    customAmount: z.boolean().optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
    autoRecharge: z
      .object({
        enabled: z.boolean(),
        threshold: z.number().int().positive().max(10_000_000).optional(),
        amount: z.number().int().min(1000).max(10_000_000).optional(),
      })
      .optional(),
  })
  .refine(
    (data) => {
      return data.customAmount !== true || data.autoRecharge === undefined;
    },
    { message: "auto-recharge is not supported for custom amount checkout" },
  )
  .refine(
    (data) => {
      return (
        data.autoRecharge?.enabled !== true ||
        data.autoRecharge.threshold === undefined ||
        data.autoRecharge.amount === undefined ||
        data.autoRecharge.threshold < data.autoRecharge.amount
      );
    },
    { message: "threshold must be less than amount to avoid recharge loops" },
  );

const portalRequestSchema = z.object({
  returnUrl: z.string().url(),
});

const autoRechargeUpdateRequestSchema = z
  .object({
    enabled: z.boolean(),
    threshold: z.number().int().positive().max(10_000_000).optional(),
    amount: z.number().int().min(1000).max(10_000_000).optional(),
  })
  .refine(
    (data) => {
      return (
        !data.enabled ||
        data.threshold === undefined ||
        data.amount === undefined ||
        data.threshold < data.amount
      );
    },
    { message: "threshold must be less than amount to avoid recharge loops" },
  );

const redeemRequestSchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Zero contract for GET /api/zero/billing/status
 */
export const zeroBillingStatusContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/billing/status",
    headers: authHeadersSchema,
    responses: {
      200: billingStatusResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get billing status for current org",
  },
});

export type ZeroBillingStatusContract = typeof zeroBillingStatusContract;

/**
 * Zero contract for POST /api/zero/billing/checkout
 */
export const zeroBillingCheckoutContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/billing/checkout",
    headers: authHeadersSchema,
    body: checkoutRequestSchema,
    responses: {
      200: checkoutResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe checkout session",
  },
  complete: {
    method: "POST",
    path: "/api/zero/billing/checkout/complete",
    headers: authHeadersSchema,
    body: checkoutCompleteRequestSchema,
    responses: {
      200: checkoutCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Complete Stripe checkout session",
  },
});

export type ZeroBillingCheckoutContract = typeof zeroBillingCheckoutContract;

/**
 * Zero contract for POST /api/zero/billing/credit-checkout
 */
export const zeroBillingCreditCheckoutContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/billing/credit-checkout",
    headers: authHeadersSchema,
    body: creditCheckoutRequestSchema,
    responses: {
      200: checkoutResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe checkout session for credits",
  },
});

export type ZeroBillingCreditCheckoutContract =
  typeof zeroBillingCreditCheckoutContract;

/**
 * Zero contract for POST /api/zero/billing/portal
 */
export const zeroBillingPortalContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/billing/portal",
    headers: authHeadersSchema,
    body: portalRequestSchema,
    responses: {
      200: portalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe billing portal session",
  },
});

export type ZeroBillingPortalContract = typeof zeroBillingPortalContract;

/**
 * Zero contract for /api/zero/billing/auto-recharge
 */
export const zeroBillingAutoRechargeContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/billing/auto-recharge",
    headers: authHeadersSchema,
    responses: {
      200: autoRechargeSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get auto-recharge configuration",
  },
  update: {
    method: "PUT",
    path: "/api/zero/billing/auto-recharge",
    headers: authHeadersSchema,
    body: autoRechargeUpdateRequestSchema,
    responses: {
      200: autoRechargeSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update auto-recharge configuration",
  },
});

export type ZeroBillingAutoRechargeContract =
  typeof zeroBillingAutoRechargeContract;

/**
 * Zero contract for GET /api/zero/billing/invoices
 */
const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  date: z.number(),
  amount: z.number(),
  status: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
});

const billingInvoicesResponseSchema = z.object({
  invoices: z.array(invoiceSchema),
});

export const zeroBillingInvoicesContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/billing/invoices",
    headers: authHeadersSchema,
    responses: {
      200: billingInvoicesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get invoices for current org",
  },
});

export type ZeroBillingInvoicesContract = typeof zeroBillingInvoicesContract;

// ---------------------------------------------------------------------------
// Downgrade
// ---------------------------------------------------------------------------

const downgradeRequestSchema = z.object({
  targetTier: z.enum(["pro-suspend", "pro"]),
});

const downgradeResponseSchema = z.object({
  success: z.boolean(),
  effectiveDate: z.string().nullable(),
});

/**
 * Zero contract for POST /api/zero/billing/downgrade
 */
export const zeroBillingDowngradeContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/billing/downgrade",
    headers: authHeadersSchema,
    body: downgradeRequestSchema,
    responses: {
      200: downgradeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Downgrade subscription to a lower tier",
  },
});

export type ZeroBillingDowngradeContract = typeof zeroBillingDowngradeContract;

/**
 * Zero contract for POST /api/zero/billing/redeem/:campaign
 *
 * One-time campaign redemption. The handler validates the campaign whitelist,
 * creates (or resumes) a Stripe Checkout session, and returns a discriminated
 * union so a single landing page on the platform can render the appropriate
 * state (ready / already_granted / processing / error).
 */
export const zeroBillingRedeemContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/billing/redeem/:campaign",
    pathParams: z.object({
      campaign: z.string(),
    }),
    headers: authHeadersSchema,
    body: redeemRequestSchema,
    responses: {
      200: redeemResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Redeem a one-time campaign",
  },
});

export type ZeroBillingRedeemContract = typeof zeroBillingRedeemContract;

// Inferred types from Zod schemas
export type BillingStatusResponse = z.infer<typeof billingStatusResponseSchema>;
export type AutoRechargeConfig = z.infer<typeof autoRechargeSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type CreditCheckoutRequest = z.infer<typeof creditCheckoutRequestSchema>;
export type PortalResponse = z.infer<typeof portalResponseSchema>;
export type BillingInvoice = z.infer<typeof invoiceSchema>;
export type BillingInvoicesResponse = z.infer<
  typeof billingInvoicesResponseSchema
>;
export type DowngradeResponse = z.infer<typeof downgradeResponseSchema>;
export type RedeemRequest = z.infer<typeof redeemRequestSchema>;
export type RedeemResponse = z.infer<typeof redeemResponseSchema>;
