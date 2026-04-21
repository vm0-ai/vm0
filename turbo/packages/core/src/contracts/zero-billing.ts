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

const billingStatusResponseSchema = z.object({
  tier: z.string(),
  credits: z.number(),
  subscriptionStatus: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  hasSubscription: z.boolean(),
  autoRecharge: autoRechargeSchema,
  creditExpiry: creditExpirySchema,
});

const checkoutResponseSchema = z.object({
  url: z.string(),
});

const portalResponseSchema = z.object({
  url: z.string(),
});

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const checkoutRequestSchema = z.object({
  tier: z.enum(["pro", "team"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const portalRequestSchema = z.object({
  returnUrl: z.string().min(1),
});

const autoRechargeUpdateRequestSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().positive().optional(),
  amount: z.number().int().min(1000).optional(),
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
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create Stripe checkout session",
  },
});

export type ZeroBillingCheckoutContract = typeof zeroBillingCheckoutContract;

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
  targetTier: z.enum(["free", "pro"]),
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

// Inferred types from Zod schemas
export type BillingStatusResponse = z.infer<typeof billingStatusResponseSchema>;
export type AutoRechargeConfig = z.infer<typeof autoRechargeSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type PortalResponse = z.infer<typeof portalResponseSchema>;
export type BillingInvoice = z.infer<typeof invoiceSchema>;
export type BillingInvoicesResponse = z.infer<
  typeof billingInvoicesResponseSchema
>;
export type DowngradeResponse = z.infer<typeof downgradeResponseSchema>;
