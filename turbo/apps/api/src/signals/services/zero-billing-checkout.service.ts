import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import type {
  ConcurrencySubscriptionChangePreviewResponse,
  CreditPurchaseConfirmResponse,
  CreditPurchasePreviewResponse,
  UsagePackUsd,
} from "@okouai/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/schema/org-plan-entitlement";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import {
  getStripeClient,
  stripeErrorInfo,
  type StripeClient,
  type StripeInvoice,
  type StripeMetadataParam,
  type StripeSubscription,
} from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { persistOrgAcquisitionAttribution$ } from "./acquisition-attribution.service";
import {
  addStripeConcurrencySubscriptionItem$,
  applyStripeConcurrencySubscriptionChange$,
  previewStripeConcurrencySubscriptionChange$,
} from "./zero-billing-concurrency-subscription.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import { safeJsonParse, settle } from "../utils";

interface CreateCheckoutSessionArgs {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
  readonly trialDays?: 7;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly adAttribution?: Readonly<Record<string, string | undefined>>;
}

interface CompleteCheckoutSessionArgs {
  readonly orgId: string;
  readonly sessionId: string;
}

type CheckoutCompletionResult =
  | { readonly status: "completed" }
  | { readonly status: "pending" }
  | { readonly status: "customer_mismatch" }
  | {
      readonly status: "tier_conflict";
      readonly currentTier: string | null;
      readonly targetTier: SubscriptionCheckoutTier;
    };

interface CreateCreditCheckoutSessionArgs {
  readonly orgId: string;
  readonly credits: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface PreviewExistingBillingCreditPurchaseArgs {
  readonly orgId: string;
  readonly credits: number;
}

type ConfirmExistingBillingCreditPurchaseResult =
  | {
      readonly status: "confirmed";
      readonly response: CreditPurchaseConfirmResponse;
    }
  | { readonly status: "invalid_preview" }
  | { readonly status: "billing_unavailable" };

interface StartConcurrencyPurchaseArgs {
  readonly orgId: string;
  readonly quantity: number;
  readonly priceId: string;
  readonly existingSubscriptionId?: string;
  readonly hasScheduledConcurrencyChange: boolean;
  readonly successUrl: string;
}

type StartConcurrencyPurchaseResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_quantity"
        | "missing_plan_subscription"
        | "pending_update";
    };

type PreviewInitialConcurrencyPurchaseResult =
  | {
      readonly ok: true;
      readonly preview: ConcurrencySubscriptionChangePreviewResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_quantity"
        | "missing_plan_subscription"
        | "not_found"
        | "canceling"
        | "no_change"
        | "pending_update";
    };

const CREDITS_PER_DOLLAR = 1000;
const CREDIT_PURCHASE_PREVIEW_TTL_MS = 15 * 60 * 1000;
const CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY = "credit_purchase_preview_id";
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
export type SubscriptionCheckoutTier =
  (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];

async function orgPlanSubscriptionId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [plan] = await db
    .select({
      stripeSubscriptionId: orgPlanEntitlements.stripeSubscriptionId,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  return plan?.stripeSubscriptionId ?? null;
}

const creditPurchasePreviewTokenSchema = z.object({
  version: z.literal(1),
  purchaseId: z.uuid(),
  orgId: z.string().min(1),
  customerId: z.string().min(1),
  paymentMethodId: z.string().min(1),
  priceId: z.string().min(1),
  quantity: z.number().int().positive(),
  credits: z.number().int().positive(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  expiresAt: z.iso.datetime(),
});

type CreditPurchasePreviewToken = z.infer<
  typeof creditPurchasePreviewTokenSchema
>;

function legacyPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("OKOU_PRICE_PRO");
    }
    case "team": {
      return env("OKOU_PRICE_TEAM");
    }
  }
}

function usagePackPlanPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("OKOU_PRICE_USAGE_PACK_PLAN_PRO");
    }
    case "team": {
      return env("OKOU_PRICE_USAGE_PACK_PLAN_TEAM");
    }
  }
}

function knownPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] {
  return [
    ...(legacyPriceIdsForTier(tier) ?? []),
    ...(usagePackPlanPriceIdsForTier(tier) ?? []),
  ];
}

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return legacyPriceIdsForTier(tier)?.[0];
}

export function activeUsagePackPlanPriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return usagePackPlanPriceIdsForTier(tier)?.[0];
}

function usagePackPriceIds(usagePackUsd: UsagePackUsd): readonly string[] {
  switch (usagePackUsd) {
    case 20: {
      return env("OKOU_PRICE_USAGE_PACK_20") ?? [];
    }
    case 50: {
      return env("OKOU_PRICE_USAGE_PACK_50") ?? [];
    }
    case 100: {
      return env("OKOU_PRICE_USAGE_PACK_100") ?? [];
    }
    case 200: {
      return env("OKOU_PRICE_USAGE_PACK_200") ?? [];
    }
  }
}

export function activeUsagePackPriceId(
  usagePackUsd: UsagePackUsd,
): string | undefined {
  return usagePackPriceIds(usagePackUsd)[0];
}

export function usagePackUsdForKnownPriceId(
  priceId: string,
): UsagePackUsd | null {
  for (const usagePackUsd of [20, 50, 100, 200] as const) {
    if (usagePackPriceIds(usagePackUsd).includes(priceId)) {
      return usagePackUsd;
    }
  }
  return null;
}

export function isUsagePackPlanPriceId(priceId: string): boolean {
  return STRIPE_SUBSCRIPTION_PRICE_TIERS.some((tier) => {
    return usagePackPlanPriceIdsForTier(tier)?.includes(priceId) ?? false;
  });
}

export function tierForKnownPriceId(
  priceId: string,
): SubscriptionCheckoutTier | null {
  for (const tier of STRIPE_SUBSCRIPTION_PRICE_TIERS) {
    if (knownPriceIdsForTier(tier).includes(priceId)) {
      return tier;
    }
  }
  return null;
}

interface PlanPriceItem {
  readonly price: { readonly id: string };
}

export function knownPlanPriceItem<T extends PlanPriceItem>(
  items: readonly T[],
): T | undefined {
  return items.find((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
}

export function tierFromPriceId(priceId: string): SubscriptionCheckoutTier {
  const tier = tierForKnownPriceId(priceId);
  if (tier) {
    return tier;
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

function billingTierRank(tier: string | null | undefined): number {
  switch (tier) {
    case "custom": {
      return 3;
    }
    case "team": {
      return 2;
    }
    case "pro": {
      return 1;
    }
    case "free":
    case "limited-free-1":
    case "pro-suspend":
    default: {
      return 0;
    }
  }
}

function billingTierLabel(tier: string | null | undefined): string {
  switch (tier) {
    case "custom": {
      return "Custom";
    }
    case "team": {
      return "Team";
    }
    case "pro": {
      return "Pro";
    }
    case "free": {
      return "Free";
    }
    case "limited-free-1": {
      return "Limited free";
    }
    case "pro-suspend": {
      return "Pro suspended";
    }
    default: {
      return tier ?? "Pro suspended";
    }
  }
}

export function checkoutWouldReplaceWithSameOrLowerTier(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: SubscriptionCheckoutTier;
}): boolean {
  return billingTierRank(args.currentTier) >= billingTierRank(args.targetTier);
}

export function checkoutTierConflictMessage(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: SubscriptionCheckoutTier;
}): string {
  return `Cannot create ${billingTierLabel(args.targetTier)} checkout while current tier is ${billingTierLabel(args.currentTier)}; use billing management to change plans`;
}

export function activeCustomCreditUnitPriceId(): string | undefined {
  return env("OKOU_PRICE_CUSTOM_CREDIT_UNIT");
}

function creditPurchasePreviewTokenSignature(encodedPayload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(encodedPayload)
    .digest();
}

function createCreditPurchasePreviewToken(
  payload: CreditPurchasePreviewToken,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature =
    creditPurchasePreviewTokenSignature(encodedPayload).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

function parseCreditPurchasePreviewToken(
  token: string,
): CreditPurchasePreviewToken | null {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return null;
  }
  const providedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = creditPurchasePreviewTokenSignature(encodedPayload);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }
  const parsed = safeJsonParse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  const result = creditPurchasePreviewTokenSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

interface ExistingCreditBilling {
  readonly customerId: string;
  readonly subscriptionId: string | null;
}

async function existingCreditBilling(
  orgId: string,
  db: ReadonlyDb,
): Promise<ExistingCreditBilling | null> {
  const [org] = await db
    .select({
      customerId: orgMetadata.stripeCustomerId,
      subscriptionId: orgMetadata.stripeSubscriptionId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (!org?.customerId) {
    return null;
  }
  return {
    customerId: org.customerId,
    subscriptionId: org.subscriptionId,
  };
}

async function existingCreditPaymentMethodId(
  stripe: StripeClient,
  billing: ExistingCreditBilling,
  signal: AbortSignal,
): Promise<string | null> {
  if (billing.subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      billing.subscriptionId,
    );
    signal.throwIfAborted();
    const subscriptionPaymentMethodId = stripeObjectId(
      subscription.default_payment_method,
    );
    if (subscriptionPaymentMethodId) {
      return subscriptionPaymentMethodId;
    }
  }

  const customer = await stripe.customers.retrieve(billing.customerId);
  signal.throwIfAborted();
  if (!("deleted" in customer) || !customer.deleted) {
    const customerPaymentMethodId = stripeObjectId(
      customer.invoice_settings?.default_payment_method,
    );
    if (customerPaymentMethodId) {
      return customerPaymentMethodId;
    }
  }

  const paymentMethods = await stripe.paymentMethods.list({
    customer: billing.customerId,
    type: "card",
    limit: 1,
  });
  signal.throwIfAborted();
  return paymentMethods.data[0]?.id ?? null;
}

function assertCreditPurchasePreviewLine(
  invoice: StripeInvoice,
  purchaseId: string,
): void {
  const hasLine = invoice.lines.data.some((candidate) => {
    return (
      candidate.metadata?.[CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY] ===
      purchaseId
    );
  });
  if (!hasLine) {
    throw new Error("Stripe credit purchase preview is missing its line item");
  }
}

function creditPurchasePayableAmount(invoice: StripeInvoice): number {
  const amount = invoice.amount_due;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Stripe credit purchase invoice has an invalid amount");
  }
  return amount;
}

export const previewExistingBillingCreditPurchase$ = command(
  async (
    { get },
    args: PreviewExistingBillingCreditPurchaseArgs,
    signal: AbortSignal,
  ): Promise<CreditPurchasePreviewResponse | null> => {
    const billing = await existingCreditBilling(args.orgId, get(db$));
    signal.throwIfAborted();
    if (!billing) {
      return null;
    }

    const stripe = getStripeClient();
    const paymentMethodId = await existingCreditPaymentMethodId(
      stripe,
      billing,
      signal,
    );
    if (!paymentMethodId) {
      return null;
    }

    const priceId = activeCustomCreditUnitPriceId();
    if (!priceId) {
      throw new Error("Custom credit price not configured");
    }
    const quantity = Math.ceil(args.credits / CREDITS_PER_DOLLAR);
    const credits = quantity * CREDITS_PER_DOLLAR;
    const purchaseId = randomUUID();
    const invoice = await stripe.invoices.createPreview({
      customer: billing.customerId,
      preview_mode: "next",
      invoice_items: [
        {
          price: priceId,
          quantity,
          metadata: {
            [CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY]: purchaseId,
          },
        },
      ],
    });
    signal.throwIfAborted();
    if (invoice.currency.length !== 3) {
      throw new Error("Stripe credit purchase preview has an invalid currency");
    }
    assertCreditPurchasePreviewLine(invoice, purchaseId);
    const amountCents = creditPurchasePayableAmount(invoice);
    const expiresAt = new Date(
      nowDate().getTime() + CREDIT_PURCHASE_PREVIEW_TTL_MS,
    ).toISOString();
    const payload: CreditPurchasePreviewToken = {
      version: 1,
      purchaseId,
      orgId: args.orgId,
      customerId: billing.customerId,
      paymentMethodId,
      priceId,
      quantity,
      credits,
      amountCents,
      currency: invoice.currency,
      expiresAt,
    };
    return {
      status: "preview",
      credits,
      amountCents,
      currency: invoice.currency,
      expiresAt,
      previewToken: createCreditPurchasePreviewToken(payload),
    };
  },
);

function isPaymentActionRequired(error: unknown): boolean {
  const code = stripeErrorInfo(error)?.code;
  return (
    code === "authentication_required" ||
    code === "invoice_payment_intent_requires_action" ||
    code === "payment_intent_action_required"
  );
}

async function finalizeCreditPurchaseInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  purchaseId: string,
  signal: AbortSignal,
): Promise<StripeInvoice> {
  if (invoice.status !== "draft") {
    return invoice;
  }
  const finalized = await stripe.invoices.finalizeInvoice(
    invoice.id,
    {},
    { idempotencyKey: `credit-purchase:${purchaseId}:finalize` },
  );
  signal.throwIfAborted();
  return finalized;
}

async function payCreditPurchaseInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  purchaseId: string,
  signal: AbortSignal,
): Promise<CreditPurchaseConfirmResponse> {
  let current = invoice;
  if (current.status === "open") {
    const paid = await settle(
      stripe.invoices.pay(
        current.id,
        {},
        { idempotencyKey: `credit-purchase:${purchaseId}:pay` },
      ),
      signal,
    );
    if (paid.ok) {
      current = paid.value;
    } else {
      if (!isPaymentActionRequired(paid.error)) {
        throw paid.error;
      }
      current = await stripe.invoices.retrieve(current.id);
    }
    signal.throwIfAborted();
  }
  if (current.status === "paid") {
    return { status: "completed", hostedInvoiceUrl: null };
  }
  if (current.hosted_invoice_url) {
    return {
      status: "pending_payment",
      hostedInvoiceUrl: current.hosted_invoice_url,
    };
  }
  throw new Error("Stripe credit purchase invoice could not be paid");
}

async function discardChangedCreditPurchaseInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  purchaseId: string,
  signal: AbortSignal,
): Promise<void> {
  if (invoice.status === "draft") {
    await stripe.invoices.del(
      invoice.id,
      {},
      { idempotencyKey: `credit-purchase:${purchaseId}:delete` },
    );
    signal.throwIfAborted();
    return;
  }
  if (invoice.status === "open" || invoice.status === "uncollectible") {
    await stripe.invoices.voidInvoice(
      invoice.id,
      {},
      { idempotencyKey: `credit-purchase:${purchaseId}:void` },
    );
    signal.throwIfAborted();
    return;
  }
  if (invoice.status !== "void") {
    throw new Error("Changed credit purchase invoice could not be discarded");
  }
}

export const confirmExistingBillingCreditPurchase$ = command(
  async (
    { get },
    orgId: string,
    previewToken: string,
    signal: AbortSignal,
  ): Promise<ConfirmExistingBillingCreditPurchaseResult> => {
    const preview = parseCreditPurchasePreviewToken(previewToken);
    if (
      !preview ||
      preview.orgId !== orgId ||
      new Date(preview.expiresAt) <= nowDate() ||
      preview.priceId !== activeCustomCreditUnitPriceId()
    ) {
      return { status: "invalid_preview" };
    }

    const billing = await existingCreditBilling(orgId, get(db$));
    signal.throwIfAborted();
    if (!billing || billing.customerId !== preview.customerId) {
      return { status: "billing_unavailable" };
    }
    const stripe = getStripeClient();
    const paymentMethodId = await existingCreditPaymentMethodId(
      stripe,
      billing,
      signal,
    );
    if (paymentMethodId !== preview.paymentMethodId) {
      return { status: "invalid_preview" };
    }

    const metadata: StripeMetadataParam = {
      purpose: "credit_purchase",
      type: "credit_purchase",
      orgId,
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: String(preview.credits),
      creditPurchaseId: preview.purchaseId,
      ...stripePreviewMetadata(),
    };
    const invoice = await stripe.invoices.create(
      {
        customer: preview.customerId,
        auto_advance: false,
        default_payment_method: preview.paymentMethodId,
        metadata,
      },
      { idempotencyKey: `credit-purchase:${preview.purchaseId}:invoice` },
    );
    signal.throwIfAborted();
    await stripe.invoiceItems.create(
      {
        invoice: invoice.id,
        customer: preview.customerId,
        pricing: { price: preview.priceId },
        quantity: preview.quantity,
        description: `Credit top-up: ${preview.credits.toLocaleString()} credits`,
        metadata: {
          [CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY]: preview.purchaseId,
        },
      },
      { idempotencyKey: `credit-purchase:${preview.purchaseId}:invoice-item` },
    );
    signal.throwIfAborted();
    const draftInvoice = await stripe.invoices.retrieve(invoice.id);
    signal.throwIfAborted();
    assertCreditPurchasePreviewLine(draftInvoice, preview.purchaseId);
    const confirmedInvoice = await finalizeCreditPurchaseInvoice(
      stripe,
      draftInvoice,
      preview.purchaseId,
      signal,
    );
    const confirmedAmountCents = creditPurchasePayableAmount(confirmedInvoice);
    if (
      confirmedInvoice.currency !== preview.currency ||
      confirmedAmountCents !== preview.amountCents
    ) {
      await discardChangedCreditPurchaseInvoice(
        stripe,
        confirmedInvoice,
        preview.purchaseId,
        signal,
      );
      return { status: "invalid_preview" };
    }
    return {
      status: "confirmed",
      response: await payCreditPurchaseInvoice(
        stripe,
        confirmedInvoice,
        preview.purchaseId,
        signal,
      ),
    };
  },
);

function checkoutSessionMetadata(args: {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
  readonly adAttribution:
    | Readonly<Record<string, string | undefined>>
    | undefined;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.priceId,
  };
  for (const [key, value] of Object.entries(args.adAttribution ?? {})) {
    if (value) {
      metadata[key] = value;
    }
  }
  Object.assign(metadata, stripePreviewMetadata());
  return metadata;
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

function subscriptionWillCancel(subscription: StripeSubscription): boolean {
  return subscription.cancel_at_period_end || subscription.cancel_at !== null;
}

/**
 * Create a Stripe Checkout session for subscription. Returns the
 * checkout session URL. Mirrors apps/web's createCheckoutSession
 * (allow_promotion_codes + subscription metadata orgId tag).
 */
export const createCheckoutSession$ = command(
  async (
    { set },
    args: CreateCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    await set(
      persistOrgAcquisitionAttribution$,
      { orgId: args.orgId, attribution: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

    const metadata = checkoutSessionMetadata({
      orgId: args.orgId,
      tier: args.tier,
      priceId: args.priceId,
      adAttribution: args.adAttribution,
    });
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId, metadata: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: args.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata,
      subscription_data: {
        metadata,
        ...(args.trialDays === undefined
          ? {}
          : { trial_period_days: args.trialDays }),
      },
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);

export const completeCheckoutSession$ = command(
  async (
    { set },
    args: CompleteCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<CheckoutCompletionResult> => {
    const db = set(writeDb$);
    const [org] = await db
      .select({
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        tier: orgMetadata.tier,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    signal.throwIfAborted();

    const customerId = stripeObjectId(session.customer);
    if (!org || !customerId || customerId !== org.stripeCustomerId) {
      return { status: "customer_mismatch" };
    }

    if (session.status !== "complete" || session.mode !== "subscription") {
      return { status: "pending" };
    }

    const subscriptionId = stripeObjectId(session.subscription);
    if (!subscriptionId) {
      return { status: "pending" };
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    signal.throwIfAborted();

    const priceId = knownPlanPriceItem(subscription.items.data)?.price.id;
    if (!priceId) {
      return { status: "pending" };
    }

    const tier = tierFromPriceId(priceId);
    if (
      org.stripeSubscriptionId !== subscription.id &&
      checkoutWouldReplaceWithSameOrLowerTier({
        currentTier: org.tier,
        targetTier: tier,
      })
    ) {
      return {
        status: "tier_conflict",
        currentTier: org.tier,
        targetTier: tier,
      };
    }
    const alreadyPaidSubscription =
      org.stripeSubscriptionId === subscription.id && org.tier === tier;

    await db
      .update(orgMetadata)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscriptionWillCancel(subscription),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          eq(orgMetadata.stripeCustomerId, customerId),
        ),
      );
    signal.throwIfAborted();

    return { status: alreadyPaidSubscription ? "completed" : "pending" };
  },
);

export const createCreditCheckoutSession$ = command(
  async (
    { set },
    args: CreateCreditCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const customer = await stripe.customers.retrieve(customerId);
    signal.throwIfAborted();
    const customerCoupon =
      "discount" in customer ? customer.discount?.source.coupon : null;
    const customerCouponId =
      typeof customerCoupon === "string" ? customerCoupon : customerCoupon?.id;
    const baseMetadata = {
      purpose: "credit_purchase",
      orgId: args.orgId,
      ...stripePreviewMetadata(),
    };
    const customCreditUnitPriceId = activeCustomCreditUnitPriceId();
    if (!customCreditUnitPriceId) {
      throw new Error("Custom credit price not configured");
    }
    const unitQuantity = Math.ceil(args.credits / CREDITS_PER_DOLLAR);
    const metadata: StripeMetadataParam = {
      ...baseMetadata,
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: String(args.credits),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: customCreditUnitPriceId, quantity: unitQuantity }],
      ...(customerCouponId
        ? { discounts: [{ coupon: customerCouponId }] }
        : { allow_promotion_codes: true }),
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: {
            type: "credit_purchase",
            ...metadata,
          },
        },
      },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          type: "credit_purchase",
          ...metadata,
        },
      },
      metadata,
    });
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);

export const previewInitialConcurrencyPurchase$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly priceId: string;
      readonly quantity: number;
    },
    signal: AbortSignal,
  ): Promise<PreviewInitialConcurrencyPurchaseResult> => {
    const subscriptionId = await orgPlanSubscriptionId(
      set(writeDb$),
      args.orgId,
    );
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { ok: false, reason: "missing_plan_subscription" };
    }
    return await set(
      previewStripeConcurrencySubscriptionChange$,
      {
        subscriptionId,
        priceId: args.priceId,
        quantity: args.quantity,
        mode: "absolute",
        hasScheduledConcurrencyChange: false,
      },
      signal,
    );
  },
);

export const startConcurrencyPurchase$ = command(
  async (
    { set },
    args: StartConcurrencyPurchaseArgs,
    signal: AbortSignal,
  ): Promise<StartConcurrencyPurchaseResult> => {
    // Old web/app clients can send existing subscriptions through this legacy
    // checkout endpoint for the ~2-day client version-skew window. Remove this
    // branch with #26152 after #26116 has been deployed beyond that window.
    if (args.existingSubscriptionId) {
      const result = await set(
        applyStripeConcurrencySubscriptionChange$,
        {
          subscriptionId: args.existingSubscriptionId,
          quantity: args.quantity,
          mode: "increase",
          hasScheduledConcurrencyChange: args.hasScheduledConcurrencyChange,
        },
        signal,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === "invalid_quantity"
              ? "invalid_quantity"
              : "pending_update",
        };
      }
      return {
        ok: true,
        url:
          result.response.status === "pending_payment"
            ? result.response.hostedInvoiceUrl
            : args.successUrl,
      };
    }

    const subscriptionId = await orgPlanSubscriptionId(
      set(writeDb$),
      args.orgId,
    );
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { ok: false, reason: "missing_plan_subscription" };
    }

    const result = await set(
      addStripeConcurrencySubscriptionItem$,
      {
        subscriptionId,
        priceId: args.priceId,
        quantity: args.quantity,
      },
      signal,
    );
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      url:
        result.response.status === "pending_payment"
          ? result.response.hostedInvoiceUrl
          : args.successUrl,
    };
  },
);
