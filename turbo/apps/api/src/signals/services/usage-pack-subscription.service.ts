import {
  USAGE_PACKS_USD,
  type UsagePackCatalogItem,
  type UsagePackUsd,
} from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  USAGE_PACK_ALLOCATION_STATUSES,
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackSubscriptions,
} from "@vm0/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  getStripeClient,
  type StripeClient,
  type StripeMetadataParam,
  type StripePrice,
} from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { upsertOrgPlanEntitlement } from "./org-plan-entitlements.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  handleUsagePackAllocationChangeInvoicePaid,
  reconcileUsagePackAllocationChanges,
  reconcileUsagePackAllocationChangeSubscription,
  reconcileUsagePackAllocationChangeSubscriptionDeleted,
} from "./usage-pack-allocation-change.service";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import {
  handleUsagePackSubscriptionChangeInvoicePaid,
  reconcileUsagePackSubscriptionChanges,
} from "./usage-pack-plan-change.service";
import {
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  tierForKnownPriceId,
  type SubscriptionCheckoutTier,
  usagePackUsdForKnownPriceId,
} from "./zero-billing-checkout.service";

const USAGE_PACK_SUBSCRIPTION_PURPOSE = "usage_pack_subscription";
const USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY = "usagePackSubscriptionId";

const CREDITS_PER_DOLLAR = 1000;
const PAYABLE_USAGE_PACK_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
] as const;
const CANCELED_USAGE_PACK_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
  "inactive",
] as const;
const USAGE_PACK_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;
const L = logger("UsagePackSubscription");

type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface ValidatedUsagePackPrice extends UsagePackCatalogItem {
  readonly stripePriceId: string;
  readonly unitAmountCents: number;
}

export type UsagePackCheckoutAllocation =
  | {
      readonly usagePackUsd: UsagePackUsd;
      readonly stripePriceId: string;
      readonly userId: string;
    }
  | {
      readonly usagePackUsd: UsagePackUsd;
      readonly stripePriceId: string;
      readonly invitationId: string;
    };

interface CreateUsagePackCheckoutSessionArgs {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly allocations: readonly UsagePackCheckoutAllocation[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly adAttribution?: Readonly<Record<string, string | undefined>>;
}

type StripeObjectReference = string | { readonly id: string };

interface UsagePackCheckoutSessionInput {
  readonly id: string;
  readonly customer: StripeObjectReference | null;
  readonly subscription: StripeObjectReference | null;
  readonly metadata: Record<string, string> | null;
  readonly status?: string | null;
}

interface UsagePackSubscriptionInput {
  readonly id: string;
  readonly customer?: StripeObjectReference | null;
  readonly status: string;
  readonly metadata?: Record<string, string> | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end: boolean;
  readonly items: {
    readonly data: readonly {
      readonly price: { readonly id: string };
      readonly quantity?: number | null;
      readonly current_period_start?: number | null;
      readonly current_period_end?: number | null;
    }[];
  };
}

interface UsagePackInvoiceLineInput {
  readonly id?: string;
  readonly amount?: number | null;
  readonly subtotal?: number | null;
  readonly quantity?: number | null;
  readonly price?: { readonly id: string } | null;
  readonly pricing?: {
    readonly price_details?: {
      readonly price?: StripeObjectReference | null;
    } | null;
  } | null;
  readonly proration?: boolean;
  readonly period: { readonly start?: number; readonly end: number };
  readonly parent: {
    readonly type: "subscription_item_details" | "invoice_item_details";
    readonly subscription_item_details?: {
      readonly proration: boolean;
    } | null;
    readonly invoice_item_details?: {
      readonly proration: boolean;
    } | null;
  } | null;
}

interface UsagePackInvoiceInput {
  readonly id: string;
  readonly customer: StripeObjectReference | null;
  readonly metadata: Record<string, string> | null;
  readonly status?: string | null;
  readonly paid?: boolean;
  readonly lines: { readonly data: readonly UsagePackInvoiceLineInput[] };
  readonly parent: {
    readonly subscription_details: {
      readonly metadata?: Record<string, string> | null;
      readonly subscription: StripeObjectReference;
    } | null;
  } | null;
}

interface ValidatedSubscriptionShape {
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date;
  readonly packageQuantities: ReadonlyMap<string, number>;
}

interface UsagePackBasePlanShape {
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
}

type InspectedSubscriptionShape =
  | { readonly valid: true; readonly shape: ValidatedSubscriptionShape }
  | { readonly valid: false; readonly reason: string };

type InspectedValue<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly reason: string };

interface UsagePackPackageShape {
  readonly periodStart: Date | null;
  readonly periodEnd: Date;
  readonly quantities: ReadonlyMap<string, number>;
}

interface UsagePackContext {
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
}

interface PreparedUsagePackAllocationGrant {
  readonly allocationId: string;
  readonly userId: string | null;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
}

interface PreparedUsagePackFulfillment {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly allocations: readonly PreparedUsagePackAllocationGrant[];
}

interface PreparedUsagePackPriceCredits {
  readonly priceId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
}

interface CommitUsagePackFulfillmentArgs {
  readonly context: UsagePackContext;
  readonly subscription: UsagePackSubscriptionInput;
  readonly invoice: UsagePackInvoiceInput;
  readonly shape: ValidatedSubscriptionShape;
  readonly fulfillment: PreparedUsagePackFulfillment;
}

interface UsagePackLifecycleOutcome {
  readonly handled: boolean;
  readonly orgId: string | null;
  readonly subscription?: UsagePackSubscriptionInput;
}

function positiveMetadataInteger(
  metadata: Readonly<Record<string, string>>,
  key: string,
): number | null {
  const value = metadata[key];
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateUsagePackPrice(
  usagePackUsd: UsagePackUsd,
  stripePriceId: string,
  price: StripePrice,
  requireActive: boolean,
): ValidatedUsagePackPrice {
  if (price.id !== stripePriceId) {
    throw new Error(
      `Stripe returned usage pack Price ${price.id} for ${stripePriceId}`,
    );
  }
  if (requireActive && !price.active) {
    throw new Error(`Usage pack Price ${stripePriceId} is inactive`);
  }
  if (
    price.currency !== "usd" ||
    price.unit_amount === null ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount <= 0
  ) {
    throw new Error(
      `Usage pack Price ${stripePriceId} must have a positive integer USD unit amount`,
    );
  }
  if (
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error(`Usage pack Price ${stripePriceId} must recur every month`);
  }

  const product = price.product;
  if (typeof product === "string" || "deleted" in product) {
    throw new Error(
      `Usage pack Price ${stripePriceId} must expand an active Product`,
    );
  }
  const bonusCredits = positiveMetadataInteger(
    product.metadata,
    "bonusCredits",
  );
  if (bonusCredits === null) {
    throw new Error(
      `Usage pack Product ${product.id} has invalid metadata.bonusCredits`,
    );
  }

  const purchasedCredits = Math.floor(
    (price.unit_amount * CREDITS_PER_DOLLAR) / 100,
  );
  const totalCredits = purchasedCredits + bonusCredits;
  if (
    !Number.isSafeInteger(purchasedCredits) ||
    purchasedCredits <= 0 ||
    !Number.isSafeInteger(totalCredits)
  ) {
    throw new Error(`Usage pack Price ${stripePriceId} exceeds credit limits`);
  }

  return {
    usagePackUsd,
    stripePriceId,
    unitAmountCents: price.unit_amount,
    priceUsd: price.unit_amount / 100,
    purchasedCredits,
    bonusCredits,
    totalCredits,
  };
}

async function loadValidatedUsagePackPrice(
  usagePackUsd: UsagePackUsd,
  stripePriceId: string,
  options: { readonly requireActive: boolean },
): Promise<ValidatedUsagePackPrice> {
  const price = await getStripeClient().prices.retrieve(stripePriceId, {
    expand: ["product"],
  });
  return validateUsagePackPrice(
    usagePackUsd,
    stripePriceId,
    price,
    options.requireActive,
  );
}

export async function loadUsagePackCatalog(): Promise<
  readonly UsagePackCatalogItem[]
> {
  const validated = await Promise.all(
    USAGE_PACKS_USD.map(async (usagePackUsd) => {
      const stripePriceId = activeUsagePackPriceId(usagePackUsd);
      if (!stripePriceId) {
        throw new Error(`Usage pack $${usagePackUsd} Price is not configured`);
      }
      return await loadValidatedUsagePackPrice(usagePackUsd, stripePriceId, {
        requireActive: true,
      });
    }),
  );
  return validated.map((item) => {
    return {
      usagePackUsd: item.usagePackUsd,
      priceUsd: item.priceUsd,
      purchasedCredits: item.purchasedCredits,
      bonusCredits: item.bonusCredits,
      totalCredits: item.totalCredits,
    };
  });
}

export async function usagePackSubscriptionSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('public.usage_pack_subscriptions') IS NOT NULL AND to_regclass('public.usage_pack_allocations') IS NOT NULL AND to_regclass('public.usage_pack_invoice_fulfillments') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

function usagePackCheckoutMetadata(args: {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly usagePackSubscriptionId: string;
  readonly adAttribution:
    | Readonly<Record<string, string | undefined>>
    | undefined;
}): StripeMetadataParam {
  const metadata: StripeMetadataParam = {
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.planPriceId,
    purpose: USAGE_PACK_SUBSCRIPTION_PURPOSE,
    [USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY]: args.usagePackSubscriptionId,
  };
  for (const [key, value] of Object.entries(args.adAttribution ?? {})) {
    if (value) {
      metadata[key] = value;
    }
  }
  Object.assign(metadata, stripePreviewMetadata());
  return metadata;
}

function usagePackLineItems(
  allocations: readonly UsagePackCheckoutAllocation[],
): readonly { readonly price: string; readonly quantity: number }[] {
  return USAGE_PACKS_USD.flatMap((usagePackUsd) => {
    const selected = allocations.filter((allocation) => {
      return allocation.usagePackUsd === usagePackUsd;
    });
    if (selected.length === 0) {
      return [];
    }
    const stripePriceId = selected[0]?.stripePriceId;
    if (
      !stripePriceId ||
      selected.some((allocation) => {
        return allocation.stripePriceId !== stripePriceId;
      })
    ) {
      throw new Error(`Usage pack $${usagePackUsd} has inconsistent Prices`);
    }
    return [{ price: stripePriceId, quantity: selected.length }];
  });
}

export const createUsagePackCheckoutSession$ = command(
  async (
    { set },
    args: CreateUsagePackCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.allocations.length === 0) {
      throw new Error("Usage pack checkout requires at least one allocation");
    }

    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId, metadata: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

    const db = set(writeDb$);
    const usagePackSubscriptionId = await db.transaction(async (tx) => {
      const [subscription] = await tx
        .insert(usagePackSubscriptions)
        .values({
          orgId: args.orgId,
          tier: args.tier,
          stripePlanPriceId: args.planPriceId,
          stripeCustomerId: customerId,
        })
        .returning({ id: usagePackSubscriptions.id });
      if (!subscription) {
        throw new Error("Failed to create usage pack subscription snapshot");
      }

      await tx.insert(usagePackAllocations).values(
        args.allocations.map((allocation) => {
          return {
            usagePackSubscriptionId: subscription.id,
            orgId: args.orgId,
            usagePackUsd: allocation.usagePackUsd,
            stripePriceId: allocation.stripePriceId,
            ...("userId" in allocation
              ? { userId: allocation.userId }
              : { invitationId: allocation.invitationId }),
          };
        }),
      );
      return subscription.id;
    });
    signal.throwIfAborted();

    const metadata = usagePackCheckoutMetadata({
      orgId: args.orgId,
      tier: args.tier,
      planPriceId: args.planPriceId,
      usagePackSubscriptionId,
      adAttribution: args.adAttribution,
    });
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        { price: args.planPriceId, quantity: 1 },
        ...usagePackLineItems(args.allocations),
      ],
      allow_promotion_codes: true,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata,
      subscription_data: { metadata },
    });
    signal.throwIfAborted();

    await db
      .update(usagePackSubscriptions)
      .set({
        stripeCheckoutSessionId: session.id,
        updatedAt: nowDate(),
      })
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId));
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);

function usagePackSubscriptionIdFromMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  if (metadata?.purpose !== USAGE_PACK_SUBSCRIPTION_PURPOSE) {
    return null;
  }
  const id = metadata[USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY];
  if (!id) {
    return null;
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new Error(`Invalid usage pack subscription ID: ${id}`);
  }
  return id;
}

function oneUsagePackSubscriptionId(
  ...metadataCandidates: readonly (
    | Readonly<Record<string, string>>
    | null
    | undefined
  )[]
): string | null {
  const ids = new Set(
    metadataCandidates.flatMap((metadata) => {
      const id = usagePackSubscriptionIdFromMetadata(metadata);
      return id ? [id] : [];
    }),
  );
  if (ids.size > 1) {
    throw new Error("Stripe usage pack metadata has conflicting local IDs");
  }
  return ids.values().next().value ?? null;
}

function stripeObjectId(value: StripeObjectReference | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function unixDate(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000);
}

async function requireUsagePackSubscriptionSchema(db: Db): Promise<void> {
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    throw new Error("Usage pack subscription schema is unavailable");
  }
}

async function loadUsagePackContext(
  db: Pick<Db, "select">,
  usagePackSubscriptionId: string,
): Promise<UsagePackContext> {
  const [subscription] = await db
    .select()
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
    .limit(1);
  if (!subscription) {
    throw new Error(
      `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
    );
  }

  const allocations = await db
    .select()
    .from(usagePackAllocations)
    .where(
      eq(usagePackAllocations.usagePackSubscriptionId, usagePackSubscriptionId),
    );
  if (allocations.length === 0) {
    throw new Error(
      `Usage pack subscription ${usagePackSubscriptionId} has no allocations`,
    );
  }
  return { subscription, allocations };
}

function payableUsagePackAllocations(
  context: UsagePackContext,
): readonly UsagePackAllocationRow[] {
  return context.allocations.filter((allocation) => {
    return PAYABLE_USAGE_PACK_ALLOCATION_STATUSES.some((status) => {
      return allocation.status === status;
    });
  });
}

function invoiceEligibleUsagePackAllocations(
  context: UsagePackContext,
): readonly UsagePackAllocationRow[] {
  if (context.subscription.subscriptionStatus === "canceled") {
    return context.allocations.filter((allocation) => {
      return CANCELED_USAGE_PACK_ALLOCATION_STATUSES.some((status) => {
        return allocation.status === status;
      });
    });
  }
  return payableUsagePackAllocations(context);
}

function usagePackSubscriptionWillCancel(
  subscription: UsagePackSubscriptionInput,
): boolean {
  return (
    subscription.cancel_at_period_end ||
    unixDate(subscription.cancel_at) !== null
  );
}

function inspectUsagePackBasePlan(
  subscription: UsagePackSubscriptionInput,
): InspectedValue<UsagePackBasePlanShape> {
  const planItems = subscription.items.data.filter((item) => {
    return isUsagePackPlanPriceId(item.price.id);
  });
  if (planItems.length !== 1) {
    return {
      valid: false,
      reason: `expected one usage pack base plan, received ${planItems.length}`,
    };
  }
  const planItem = planItems[0];
  if (!planItem) {
    return { valid: false, reason: "missing usage pack base plan" };
  }
  const planQuantity = planItem.quantity ?? 1;
  if (planQuantity !== 1) {
    return {
      valid: false,
      reason: `usage pack base plan quantity must be one, received ${planQuantity}`,
    };
  }
  const tier = tierForKnownPriceId(planItem.price.id);
  if (!tier) {
    return {
      valid: false,
      reason: `usage pack base plan ${planItem.price.id} is not recognized`,
    };
  }
  return { valid: true, value: { tier, priceId: planItem.price.id } };
}

function inspectStripeUsagePackPackages(
  subscription: UsagePackSubscriptionInput,
): InspectedValue<UsagePackPackageShape> {
  const quantities = new Map<string, number>();
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return {
        valid: false,
        reason: `usage pack Price ${item.price.id} has invalid quantity ${quantity}`,
      };
    }
    quantities.set(
      item.price.id,
      (quantities.get(item.price.id) ?? 0) + quantity,
    );

    const itemPeriodEnd = unixDate(item.current_period_end);
    const itemPeriodStart = unixDate(item.current_period_start);
    if (!itemPeriodEnd) {
      return {
        valid: false,
        reason: `usage pack Price ${item.price.id} has no current period end`,
      };
    }
    if (periodEnd && periodEnd.getTime() !== itemPeriodEnd.getTime()) {
      return {
        valid: false,
        reason: "usage pack items have different current period ends",
      };
    }
    if (
      periodStart &&
      itemPeriodStart &&
      periodStart.getTime() !== itemPeriodStart.getTime()
    ) {
      return {
        valid: false,
        reason: "usage pack items have different current period starts",
      };
    }
    periodStart ??= itemPeriodStart;
    periodEnd = itemPeriodEnd;
  }
  if (quantities.size === 0 || !periodEnd) {
    return {
      valid: false,
      reason: "subscription has no recognized usage pack item",
    };
  }
  return { valid: true, value: { quantities, periodStart, periodEnd } };
}

function inspectAllocationQuantities(
  allocations: readonly UsagePackAllocationRow[],
): InspectedValue<ReadonlyMap<string, number>> {
  if (allocations.length === 0) {
    return {
      valid: false,
      reason: "local usage pack subscription has no payable allocations",
    };
  }
  const quantities = new Map<string, number>();
  for (const allocation of allocations) {
    const usagePackUsd = usagePackUsdForKnownPriceId(allocation.stripePriceId);
    if (usagePackUsd !== allocation.usagePackUsd) {
      return {
        valid: false,
        reason: `allocation ${allocation.id} has an inconsistent usage pack Price`,
      };
    }
    quantities.set(
      allocation.stripePriceId,
      (quantities.get(allocation.stripePriceId) ?? 0) + 1,
    );
  }
  return { valid: true, value: quantities };
}

function usagePackAllocationsForStripeQuantities(
  context: UsagePackContext,
  stripeQuantities: ReadonlyMap<string, number>,
): InspectedValue<readonly UsagePackAllocationRow[]> {
  const current = invoiceEligibleUsagePackAllocations(context);
  const acceptedPending = context.allocations.filter((allocation) => {
    return (
      allocation.status === "paid_pending_invitation" &&
      allocation.userId !== null
    );
  });
  const candidates =
    acceptedPending.length === 0
      ? [current]
      : [current, [...current, ...acceptedPending]];
  let reason = "Local usage pack allocations do not match Stripe";
  for (const candidate of candidates) {
    const inspected = inspectAllocationQuantities(candidate);
    if (!inspected.valid) {
      reason = inspected.reason;
      continue;
    }
    const mismatch = usagePackQuantityMismatchReason(
      stripeQuantities,
      inspected.value,
    );
    if (!mismatch) {
      return { valid: true, value: candidate };
    }
    reason = mismatch;
  }
  return { valid: false, reason };
}

function usagePackQuantityMismatchReason(
  stripeQuantities: ReadonlyMap<string, number>,
  allocationQuantities: ReadonlyMap<string, number>,
): string | null {
  if (allocationQuantities.size !== stripeQuantities.size) {
    return "Stripe package Prices do not match the allocation snapshot";
  }
  for (const [priceId, quantity] of stripeQuantities) {
    if (allocationQuantities.get(priceId) !== quantity) {
      return `Stripe quantity for ${priceId} does not match the allocation snapshot`;
    }
  }
  return null;
}

function inspectUsagePackSubscriptionShape(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
): InspectedSubscriptionShape {
  const basePlan = inspectUsagePackBasePlan(subscription);
  if (!basePlan.valid) {
    return basePlan;
  }
  const packages = inspectStripeUsagePackPackages(subscription);
  if (!packages.valid) {
    return packages;
  }
  const allocations = usagePackAllocationsForStripeQuantities(
    context,
    packages.value.quantities,
  );
  if (!allocations.valid) {
    return allocations;
  }

  return {
    valid: true,
    shape: {
      tier: basePlan.value.tier,
      planPriceId: basePlan.value.priceId,
      periodStart: packages.value.periodStart,
      periodEnd: packages.value.periodEnd,
      packageQuantities: packages.value.quantities,
    },
  };
}

function requireUsagePackSubscriptionShape(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
): ValidatedSubscriptionShape {
  const inspected = inspectUsagePackSubscriptionShape(context, subscription);
  if (!inspected.valid) {
    throw new Error(
      `Invalid usage pack subscription ${subscription.id}: ${inspected.reason}`,
    );
  }
  return inspected.shape;
}

function validateUsagePackSubscriptionCorrelation(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
  usagePackSubscriptionId: string,
): void {
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId || customerId !== context.subscription.stripeCustomerId) {
    throw new Error(
      `Stripe customer for usage pack subscription ${subscription.id} does not match the local snapshot`,
    );
  }
  if (
    context.subscription.stripeSubscriptionId &&
    context.subscription.stripeSubscriptionId !== subscription.id
  ) {
    throw new Error(
      `Stripe subscription ${subscription.id} does not match the locally bound subscription`,
    );
  }
  const metadataId = oneUsagePackSubscriptionId(subscription.metadata);
  if (metadataId !== usagePackSubscriptionId) {
    throw new Error(
      `Stripe subscription ${subscription.id} is missing its local usage pack correlation`,
    );
  }
}

async function synchronizeUsagePackSubscriptionState(
  db: Db,
  args: {
    readonly usagePackSubscriptionId: string;
    readonly checkoutSessionId?: string;
    readonly subscription: UsagePackSubscriptionInput;
  },
): Promise<UsagePackContext> {
  const context = await loadUsagePackContext(db, args.usagePackSubscriptionId);
  validateUsagePackSubscriptionCorrelation(
    context,
    args.subscription,
    args.usagePackSubscriptionId,
  );
  const shape = requireUsagePackSubscriptionShape(context, args.subscription);
  if (
    args.checkoutSessionId &&
    context.subscription.stripeCheckoutSessionId &&
    context.subscription.stripeCheckoutSessionId !== args.checkoutSessionId
  ) {
    throw new Error(
      `Checkout Session ${args.checkoutSessionId} does not match the local usage pack snapshot`,
    );
  }

  await db.transaction(async (tx) => {
    const updatedAt = nowDate();
    const cancelAtPeriodEnd = usagePackSubscriptionWillCancel(
      args.subscription,
    );
    await tx
      .update(usagePackSubscriptions)
      .set({
        tier: shape.tier,
        stripePlanPriceId: shape.planPriceId,
        stripeSubscriptionId: args.subscription.id,
        subscriptionStatus: args.subscription.status,
        cancelAtPeriodEnd,
        updatedAt,
        ...(args.checkoutSessionId
          ? { stripeCheckoutSessionId: args.checkoutSessionId }
          : {}),
      })
      .where(eq(usagePackSubscriptions.id, args.usagePackSubscriptionId));
    await tx
      .update(orgMetadata)
      .set({
        subscriptionStatus: args.subscription.status,
        cancelAtPeriodEnd,
        updatedAt,
      })
      .where(
        and(
          eq(orgMetadata.orgId, context.subscription.orgId),
          eq(orgMetadata.stripeSubscriptionId, args.subscription.id),
        ),
      );
  });
  return context;
}

export async function handleUsagePackCheckoutCompleted(
  db: Db,
  session: UsagePackCheckoutSessionInput,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = oneUsagePackSubscriptionId(session.metadata);
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await requireUsagePackSubscriptionSchema(db);

  const customerId = stripeObjectId(session.customer);
  const subscriptionId = stripeObjectId(session.subscription);
  if (!customerId || !subscriptionId) {
    throw new Error(
      `Usage pack Checkout Session ${session.id} is missing its customer or subscription`,
    );
  }
  if (subscription.id !== subscriptionId) {
    throw new Error(
      `Usage pack Checkout Session ${session.id} resolved the wrong subscription`,
    );
  }
  const context = await synchronizeUsagePackSubscriptionState(db, {
    usagePackSubscriptionId,
    checkoutSessionId: session.id,
    subscription,
  });
  if (context.subscription.stripeCustomerId !== customerId) {
    throw new Error(
      `Usage pack Checkout Session ${session.id} resolved the wrong customer`,
    );
  }
  return {
    handled: true,
    orgId: context.subscription.orgId,
    subscription,
  };
}

async function deactivateInvalidUsagePackSubscription(
  db: Db,
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
  reason: string,
  subscriptionStatus = "invalid",
): Promise<void> {
  await db.transaction(async (tx) => {
    const updatedAt = nowDate();
    await tx
      .update(usagePackSubscriptions)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionStatus,
        cancelAtPeriodEnd: false,
        updatedAt,
      })
      .where(eq(usagePackSubscriptions.id, context.subscription.id));
    await tx
      .update(usagePackAllocations)
      .set({ status: "inactive", updatedAt })
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          context.subscription.id,
        ),
      );

    const downgraded = await tx
      .update(orgMetadata)
      .set({
        tier: "limited-free-1",
        stripeSubscriptionId: null,
        subscriptionStatus,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        updatedAt,
      })
      .where(
        and(
          eq(orgMetadata.orgId, context.subscription.orgId),
          eq(orgMetadata.stripeSubscriptionId, subscription.id),
        ),
      )
      .returning({ orgId: orgMetadata.orgId });
    for (const row of downgraded) {
      await upsertOrgPlanEntitlement(tx, {
        orgId: row.orgId,
        tier: "limited-free-1",
        source: "stripe_subscription",
        sourceMetadata: {
          ...subscription.metadata,
          usagePackInvalidReason: reason,
        },
      });
    }
  });
}

async function handleUsagePackSubscriptionChanged(
  db: Db,
  eventSubscription: UsagePackSubscriptionInput,
  invalidShape: "throw" | "deactivate",
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = oneUsagePackSubscriptionId(
    eventSubscription.metadata,
  );
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await requireUsagePackSubscriptionSchema(db);

  const currentSubscription = (await getStripeClient().subscriptions.retrieve(
    eventSubscription.id,
  )) as UsagePackSubscriptionInput;
  await reconcileUsagePackAllocationChangeSubscription(db, currentSubscription);
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  validateUsagePackSubscriptionCorrelation(
    context,
    currentSubscription,
    usagePackSubscriptionId,
  );
  const inspected = inspectUsagePackSubscriptionShape(
    context,
    currentSubscription,
  );
  if (
    invalidShape === "deactivate" &&
    (currentSubscription.status === "canceled" ||
      currentSubscription.status === "incomplete_expired")
  ) {
    const reason = `terminal Stripe status ${currentSubscription.status}`;
    await deactivateInvalidUsagePackSubscription(
      db,
      context,
      currentSubscription,
      reason,
      currentSubscription.status,
    );
    return {
      handled: true,
      orgId: context.subscription.orgId,
      subscription: currentSubscription,
    };
  }
  if (!inspected.valid) {
    if (invalidShape === "throw") {
      throw new Error(
        `Invalid usage pack subscription ${currentSubscription.id}: ${inspected.reason}`,
      );
    }
    await deactivateInvalidUsagePackSubscription(
      db,
      context,
      currentSubscription,
      inspected.reason,
    );
    L.warn("invalid usage pack subscription deactivated", {
      usagePackSubscriptionId,
      stripeSubscriptionId: currentSubscription.id,
      reason: inspected.reason,
    });
    return {
      handled: true,
      orgId: context.subscription.orgId,
      subscription: currentSubscription,
    };
  }

  await synchronizeUsagePackSubscriptionState(db, {
    usagePackSubscriptionId,
    subscription: currentSubscription,
  });
  return {
    handled: true,
    orgId: context.subscription.orgId,
    subscription: currentSubscription,
  };
}

export async function handleUsagePackSubscriptionCreated(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  return await handleUsagePackSubscriptionChanged(db, subscription, "throw");
}

export async function handleUsagePackSubscriptionUpdated(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  return await handleUsagePackSubscriptionChanged(
    db,
    subscription,
    "deactivate",
  );
}

export async function handleUsagePackSubscriptionDeleted(
  db: Db,
  subscription: Pick<UsagePackSubscriptionInput, "id" | "metadata">,
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = oneUsagePackSubscriptionId(
    subscription.metadata,
  );
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await requireUsagePackSubscriptionSchema(db);
  await reconcileUsagePackAllocationChangeSubscriptionDeleted(db, subscription);
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  if (
    context.subscription.stripeSubscriptionId &&
    context.subscription.stripeSubscriptionId !== subscription.id
  ) {
    throw new Error(
      `Deleted Stripe subscription ${subscription.id} does not match the local usage pack snapshot`,
    );
  }

  await db.transaction(async (tx) => {
    const updatedAt = nowDate();
    await tx
      .update(usagePackSubscriptions)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: false,
        updatedAt,
      })
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId));
    await tx
      .update(usagePackAllocations)
      .set({ status: "inactive", updatedAt })
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      );
  });
  return { handled: true, orgId: context.subscription.orgId };
}

function invoiceSubscriptionId(invoice: UsagePackInvoiceInput): string | null {
  return stripeObjectId(invoice.parent?.subscription_details?.subscription);
}

function invoiceLinePriceId(line: UsagePackInvoiceLineInput): string | null {
  return (
    line.price?.id ?? stripeObjectId(line.pricing?.price_details?.price ?? null)
  );
}

function invoiceLineAmount(line: UsagePackInvoiceLineInput): number | null {
  const amount = line.subtotal ?? line.amount;
  return typeof amount === "number" && Number.isSafeInteger(amount)
    ? amount
    : null;
}

function invoiceLineIsProration(line: UsagePackInvoiceLineInput): boolean {
  if (line.parent?.type === "subscription_item_details") {
    return (
      line.parent.subscription_item_details?.proration ??
      line.proration ??
      false
    );
  }
  if (line.parent?.type === "invoice_item_details") {
    return (
      line.parent.invoice_item_details?.proration ?? line.proration ?? false
    );
  }
  return line.proration ?? false;
}

function isUsagePackPlanChangeInvoice(invoice: UsagePackInvoiceInput): boolean {
  return (
    invoice.lines.data.some((line) => {
      const priceId = invoiceLinePriceId(line);
      return priceId !== null && isUsagePackPlanPriceId(priceId);
    }) &&
    invoice.lines.data.every((line) => {
      const priceId = invoiceLinePriceId(line);
      return priceId === null || usagePackUsdForKnownPriceId(priceId) === null;
    })
  );
}

async function loadFulfillmentCatalog(
  shape: ValidatedSubscriptionShape,
): Promise<ReadonlyMap<string, ValidatedUsagePackPrice>> {
  const entries = await Promise.all(
    [...shape.packageQuantities.keys()].map(async (priceId) => {
      const usagePackUsd = usagePackUsdForKnownPriceId(priceId);
      if (usagePackUsd === null) {
        throw new Error(`Unknown usage pack Price: ${priceId}`);
      }
      const catalogItem = await loadValidatedUsagePackPrice(
        usagePackUsd,
        priceId,
        { requireActive: false },
      );
      return [priceId, catalogItem] as const;
    }),
  );
  return new Map(entries);
}

function prepareUsagePackPriceCredits(
  invoice: UsagePackInvoiceInput,
  shape: ValidatedSubscriptionShape,
  priceId: string,
  subscriptionQuantity: number,
  catalogItem: ValidatedUsagePackPrice,
): PreparedUsagePackPriceCredits {
  const matchingLines = invoice.lines.data.filter((line) => {
    const amount = invoiceLineAmount(line);
    return (
      invoiceLinePriceId(line) === priceId && amount !== null && amount > 0
    );
  });
  if (matchingLines.length !== 1) {
    throw new Error(
      `Invoice ${invoice.id} must have one positive line for usage pack Price ${priceId}`,
    );
  }
  const line = matchingLines[0];
  if (!line) {
    throw new Error(
      `Invoice ${invoice.id} is missing validated usage pack Price ${priceId}`,
    );
  }
  const lineQuantity = line.quantity ?? 1;
  if (lineQuantity !== subscriptionQuantity) {
    throw new Error(
      `Invoice ${invoice.id} quantity for ${priceId} does not match the subscription`,
    );
  }
  const amount = invoiceLineAmount(line);
  if (amount === null || amount <= 0) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid amount for ${priceId}`,
    );
  }
  const fullAmount = catalogItem.unitAmountCents * subscriptionQuantity;
  if (!Number.isSafeInteger(fullAmount) || amount > fullAmount) {
    throw new Error(
      `Invoice ${invoice.id} amount for ${priceId} exceeds its configured Price`,
    );
  }
  if (amount < fullAmount && !invoiceLineIsProration(line)) {
    throw new Error(
      `Invoice ${invoice.id} has a partial non-proration line for ${priceId}`,
    );
  }
  const fraction = amount / fullAmount;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid paid fraction for ${priceId}`,
    );
  }

  const periodStart = unixDate(line.period.start);
  const periodEnd = unixDate(line.period.end);
  if (!periodStart || !periodEnd || periodEnd <= periodStart) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid period for ${priceId}`,
    );
  }
  if (periodEnd > shape.periodEnd) {
    throw new Error(
      `Invoice ${invoice.id} period for ${priceId} extends beyond Stripe's current period`,
    );
  }
  return {
    priceId,
    periodStart,
    periodEnd,
    purchasedCredits: Math.floor(catalogItem.purchasedCredits * fraction),
    bonusCredits: Math.floor(catalogItem.bonusCredits * fraction),
  };
}

function commonUsagePackInvoicePeriod(
  invoiceId: string,
  preparedPrices: readonly PreparedUsagePackPriceCredits[],
): { readonly periodStart: Date; readonly periodEnd: Date } {
  const first = preparedPrices[0];
  if (!first) {
    throw new Error(`Invoice ${invoiceId} has no payable usage pack period`);
  }
  const consistent = preparedPrices.every((prepared) => {
    return (
      prepared.periodStart.getTime() === first.periodStart.getTime() &&
      prepared.periodEnd.getTime() === first.periodEnd.getTime()
    );
  });
  if (!consistent) {
    throw new Error(
      `Invoice ${invoiceId} usage pack lines have inconsistent periods`,
    );
  }
  return { periodStart: first.periodStart, periodEnd: first.periodEnd };
}

function prepareUsagePackAllocationGrants(
  context: UsagePackContext,
  preparedPrices: readonly PreparedUsagePackPriceCredits[],
  stripeQuantities: ReadonlyMap<string, number>,
): readonly PreparedUsagePackAllocationGrant[] {
  const creditsByPriceId = new Map(
    preparedPrices.map((prepared) => {
      return [prepared.priceId, prepared] as const;
    }),
  );
  const allocations = usagePackAllocationsForStripeQuantities(
    context,
    stripeQuantities,
  );
  if (!allocations.valid) {
    throw new Error(allocations.reason);
  }
  return allocations.value.map((allocation) => {
    const credits = creditsByPriceId.get(allocation.stripePriceId);
    if (!credits) {
      throw new Error(
        `Allocation ${allocation.id} has no matching invoice line`,
      );
    }
    return {
      allocationId: allocation.id,
      userId: allocation.userId,
      purchasedCredits: credits.purchasedCredits,
      bonusCredits: credits.bonusCredits,
    };
  });
}

async function prepareUsagePackFulfillment(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
  invoice: UsagePackInvoiceInput,
): Promise<{
  readonly shape: ValidatedSubscriptionShape;
  readonly fulfillment: PreparedUsagePackFulfillment;
}> {
  const shape = requireUsagePackSubscriptionShape(context, subscription);
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId !== subscription.id) {
    throw new Error(
      `Invoice ${invoice.id} does not belong to usage pack subscription ${subscription.id}`,
    );
  }
  const invoiceCustomerId = stripeObjectId(invoice.customer);
  if (invoiceCustomerId !== context.subscription.stripeCustomerId) {
    throw new Error(
      `Invoice ${invoice.id} customer does not match the usage pack snapshot`,
    );
  }

  const catalogByPriceId = await loadFulfillmentCatalog(shape);
  const preparedPrices = [...shape.packageQuantities].map(
    ([priceId, subscriptionQuantity]) => {
      const catalogItem = catalogByPriceId.get(priceId);
      if (!catalogItem) {
        throw new Error(`Unknown usage pack Price: ${priceId}`);
      }
      return prepareUsagePackPriceCredits(
        invoice,
        shape,
        priceId,
        subscriptionQuantity,
        catalogItem,
      );
    },
  );
  const { periodStart, periodEnd } = commonUsagePackInvoicePeriod(
    invoice.id,
    preparedPrices,
  );

  return {
    shape,
    fulfillment: {
      periodStart,
      periodEnd,
      allocations: prepareUsagePackAllocationGrants(
        context,
        preparedPrices,
        shape.packageQuantities,
      ),
    },
  };
}

async function usagePackInvoiceAlreadyFulfilled(
  db: Pick<Db, "select">,
  invoiceId: string,
  usagePackSubscriptionId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({
      usagePackSubscriptionId:
        usagePackInvoiceFulfillments.usagePackSubscriptionId,
    })
    .from(usagePackInvoiceFulfillments)
    .where(eq(usagePackInvoiceFulfillments.stripeInvoiceId, invoiceId))
    .limit(1);
  if (!existing) {
    return false;
  }
  if (existing.usagePackSubscriptionId !== usagePackSubscriptionId) {
    throw new Error(
      `Invoice ${invoiceId} is already bound to a different usage pack subscription`,
    );
  }
  return true;
}

function usagePackGrantIdempotencyKey(
  invoiceId: string,
  allocationId: string,
  grantType: "purchased" | "bonus",
): string {
  return `usage-pack:${invoiceId}:${allocationId}:${grantType}`;
}

async function requireCurrentFulfillmentAllocations(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  const allocationIds = args.fulfillment.allocations.map((allocation) => {
    return allocation.allocationId;
  });
  const currentAllocations = await tx
    .select({ id: usagePackAllocations.id })
    .from(usagePackAllocations)
    .where(
      and(
        eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
        inArray(usagePackAllocations.id, allocationIds),
        inArray(usagePackAllocations.status, [
          ...(subscription.subscriptionStatus === "canceled"
            ? USAGE_PACK_ALLOCATION_STATUSES
            : [
                ...PAYABLE_USAGE_PACK_ALLOCATION_STATUSES,
                "paid_pending_invitation" as const,
              ]),
        ]),
      ),
    );
  if (currentAllocations.length !== allocationIds.length) {
    throw new Error(
      `Usage pack allocations changed while fulfilling invoice ${args.invoice.id}`,
    );
  }
}

async function createUsagePackMemberGrants(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  for (const allocation of args.fulfillment.allocations) {
    if (!allocation.userId) {
      continue;
    }
    if (allocation.purchasedCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: subscription.orgId,
        userId: allocation.userId,
        grantType: "purchased",
        idempotencyKey: usagePackGrantIdempotencyKey(
          args.invoice.id,
          allocation.allocationId,
          "purchased",
        ),
        amount: allocation.purchasedCredits,
        expiresAt: args.fulfillment.periodEnd,
      });
    }
    if (allocation.bonusCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: subscription.orgId,
        userId: allocation.userId,
        grantType: "bonus",
        idempotencyKey: usagePackGrantIdempotencyKey(
          args.invoice.id,
          allocation.allocationId,
          "bonus",
        ),
        amount: allocation.bonusCredits,
        expiresAt: args.fulfillment.periodEnd,
      });
    }
  }
}

async function persistUsagePackPlanState(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: {
    readonly stripeSubscription: UsagePackSubscriptionInput;
    readonly shape: ValidatedSubscriptionShape;
    readonly periodStart: Date | null;
    readonly periodEnd: Date;
    readonly updatedAt: Date;
  },
): Promise<void> {
  await tx
    .update(usagePackSubscriptions)
    .set({
      tier: args.shape.tier,
      stripePlanPriceId: args.shape.planPriceId,
      stripeSubscriptionId: args.stripeSubscription.id,
      subscriptionStatus: args.stripeSubscription.status,
      currentPeriodStart: args.periodStart,
      currentPeriodEnd: args.periodEnd,
      cancelAtPeriodEnd: usagePackSubscriptionWillCancel(
        args.stripeSubscription,
      ),
      updatedAt: args.updatedAt,
    })
    .where(eq(usagePackSubscriptions.id, subscription.id));

  const orgRows = await tx
    .update(orgMetadata)
    .set({
      tier: args.shape.tier,
      stripeSubscriptionId: args.stripeSubscription.id,
      subscriptionStatus: args.stripeSubscription.status,
      currentPeriodEnd: args.periodEnd,
      cancelAtPeriodEnd: usagePackSubscriptionWillCancel(
        args.stripeSubscription,
      ),
      updatedAt: args.updatedAt,
    })
    .where(
      and(
        eq(orgMetadata.orgId, subscription.orgId),
        eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
      ),
    )
    .returning({ orgId: orgMetadata.orgId });
  if (orgRows.length !== 1) {
    throw new Error(
      `Usage pack subscription ${subscription.id} has no matching organization billing record`,
    );
  }

  const cancelAt =
    unixDate(args.stripeSubscription.cancel_at) ??
    (args.stripeSubscription.cancel_at_period_end ? args.periodEnd : null);
  await upsertOrgPlanEntitlement(tx, {
    orgId: subscription.orgId,
    tier: args.shape.tier,
    source: "stripe_subscription",
    status: args.stripeSubscription.status,
    stripeSubscriptionId: args.stripeSubscription.id,
    stripePriceId: args.shape.planPriceId,
    currentPeriodStart: args.periodStart,
    currentPeriodEnd: args.periodEnd,
    cancelAt,
    expiresAt: cancelAt,
    sourceMetadata: args.stripeSubscription.metadata ?? {},
  });
}

async function advanceUsagePackProjection(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  if (subscription.subscriptionStatus === "canceled") {
    return;
  }
  const updatedAt = nowDate();
  const advancesProjection =
    subscription.currentPeriodEnd === null ||
    subscription.currentPeriodEnd <= args.fulfillment.periodEnd;
  if (!advancesProjection) {
    if (!subscription.stripeSubscriptionId) {
      await tx
        .update(usagePackSubscriptions)
        .set({ stripeSubscriptionId: args.subscription.id, updatedAt })
        .where(eq(usagePackSubscriptions.id, subscription.id));
    }
    return;
  }

  for (const allocation of args.fulfillment.allocations) {
    await tx
      .update(usagePackAllocations)
      .set({
        status: allocation.userId ? "active" : "pending_invitation",
        currentPeriodStart: args.fulfillment.periodStart,
        currentPeriodEnd: args.fulfillment.periodEnd,
        updatedAt,
      })
      .where(eq(usagePackAllocations.id, allocation.allocationId));
  }
  await persistUsagePackPlanState(tx, subscription, {
    stripeSubscription: args.subscription,
    shape: args.shape,
    periodStart: args.fulfillment.periodStart,
    periodEnd: args.fulfillment.periodEnd,
    updatedAt,
  });
}

async function activateUsagePackPlanFromSubscription(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = oneUsagePackSubscriptionId(
    subscription.metadata,
  );
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await requireUsagePackSubscriptionSchema(db);
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  validateUsagePackSubscriptionCorrelation(
    context,
    subscription,
    usagePackSubscriptionId,
  );
  const shape = requireUsagePackSubscriptionShape(context, subscription);
  if (!shape.periodStart) {
    throw new Error(
      `Usage pack subscription ${subscription.id} has no current period start`,
    );
  }
  await db.transaction(async (tx) => {
    const [lockedSubscription] = await tx
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
      .for("update")
      .limit(1);
    if (!lockedSubscription) {
      throw new Error(
        `Usage pack subscription ${usagePackSubscriptionId} disappeared during plan activation`,
      );
    }
    await persistUsagePackPlanState(tx, lockedSubscription, {
      stripeSubscription: subscription,
      shape,
      periodStart: shape.periodStart,
      periodEnd: shape.periodEnd,
      updatedAt: nowDate(),
    });
  });
  return { handled: true, orgId: context.subscription.orgId, subscription };
}

async function commitUsagePackFulfillmentTransaction(
  tx: WriteTx,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  const [lockedSubscription] = await tx
    .select()
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.id, args.context.subscription.id))
    .for("update")
    .limit(1);
  if (!lockedSubscription) {
    throw new Error(
      `Usage pack subscription ${args.context.subscription.id} disappeared during fulfillment`,
    );
  }
  if (
    await usagePackInvoiceAlreadyFulfilled(
      tx,
      args.invoice.id,
      lockedSubscription.id,
    )
  ) {
    return;
  }
  if (
    lockedSubscription.stripeSubscriptionId &&
    lockedSubscription.stripeSubscriptionId !== args.subscription.id
  ) {
    throw new Error(
      `Usage pack subscription ${lockedSubscription.id} changed Stripe subscriptions during fulfillment`,
    );
  }

  await requireCurrentFulfillmentAllocations(tx, lockedSubscription, args);
  await createUsagePackMemberGrants(tx, lockedSubscription, args);
  await advanceUsagePackProjection(tx, lockedSubscription, args);
  await tx.insert(usagePackInvoiceFulfillments).values({
    stripeInvoiceId: args.invoice.id,
    usagePackSubscriptionId: lockedSubscription.id,
    periodStart: args.fulfillment.periodStart,
    periodEnd: args.fulfillment.periodEnd,
  });
}

async function commitUsagePackFulfillment(
  db: Db,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  await db.transaction(async (tx) => {
    await commitUsagePackFulfillmentTransaction(tx, args);
  });
}

export async function handleUsagePackInvoicePaid(
  db: Db,
  invoice: UsagePackInvoiceInput,
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = oneUsagePackSubscriptionId(
    invoice.metadata,
    invoice.parent?.subscription_details?.metadata,
  );
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await requireUsagePackSubscriptionSchema(db);
  const subscriptionChangeOutcome =
    await handleUsagePackSubscriptionChangeInvoicePaid(db, invoice);
  if (subscriptionChangeOutcome.handled) {
    await activateUsagePackPlanFromSubscription(
      db,
      subscriptionChangeOutcome.subscription,
    );
    return {
      handled: true,
      orgId: subscriptionChangeOutcome.orgId,
      subscription: subscriptionChangeOutcome.subscription,
    };
  }
  const changeOutcome = await handleUsagePackAllocationChangeInvoicePaid(
    db,
    invoice,
  );
  if (changeOutcome.handled) {
    return changeOutcome;
  }
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  if (
    await usagePackInvoiceAlreadyFulfilled(
      db,
      invoice.id,
      usagePackSubscriptionId,
    )
  ) {
    return { handled: true, orgId: context.subscription.orgId };
  }

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    throw new Error(
      `Usage pack invoice ${invoice.id} is missing its Stripe subscription`,
    );
  }
  const subscription = (await getStripeClient().subscriptions.retrieve(
    subscriptionId,
  )) as UsagePackSubscriptionInput;
  await reconcileUsagePackAllocationChangeSubscription(db, subscription);
  const reconciledContext = await loadUsagePackContext(
    db,
    usagePackSubscriptionId,
  );
  validateUsagePackSubscriptionCorrelation(
    reconciledContext,
    subscription,
    usagePackSubscriptionId,
  );
  if (isUsagePackPlanChangeInvoice(invoice)) {
    const shape = requireUsagePackSubscriptionShape(
      reconciledContext,
      subscription,
    );
    await activateUsagePackPlanFromSubscription(db, subscription);
    await db
      .insert(usagePackInvoiceFulfillments)
      .values({
        stripeInvoiceId: invoice.id,
        usagePackSubscriptionId,
        periodStart: shape.periodStart,
        periodEnd: shape.periodEnd,
      })
      .onConflictDoNothing();
    return { handled: true, orgId: reconciledContext.subscription.orgId };
  }
  const prepared = await prepareUsagePackFulfillment(
    reconciledContext,
    subscription,
    invoice,
  );
  await commitUsagePackFulfillment(db, {
    context: reconciledContext,
    subscription,
    invoice,
    ...prepared,
  });

  L.debug("usage pack invoice fulfilled", {
    invoiceId: invoice.id,
    usagePackSubscriptionId,
    orgId: reconciledContext.subscription.orgId,
    allocations: prepared.fulfillment.allocations.length,
    periodEnd: prepared.fulfillment.periodEnd.toISOString(),
  });
  return { handled: true, orgId: reconciledContext.subscription.orgId };
}

interface ReconcileUsagePackSubscriptionResult {
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}

async function reconcileUsagePackSubscriptionCandidate(
  db: Db,
  stripe: StripeClient,
  candidate: UsagePackSubscriptionRow,
  signal: AbortSignal,
): Promise<ReconcileUsagePackSubscriptionResult> {
  const orgIds = new Set<string>();
  let subscriptionId = candidate.stripeSubscriptionId;
  if (!subscriptionId && candidate.stripeCheckoutSessionId) {
    const session = (await stripe.checkout.sessions.retrieve(
      candidate.stripeCheckoutSessionId,
    )) as UsagePackCheckoutSessionInput;
    signal.throwIfAborted();
    if (session.status !== "complete") {
      if (session.status === "expired") {
        await db
          .update(usagePackSubscriptions)
          .set({
            subscriptionStatus: "checkout_expired",
            updatedAt: nowDate(),
          })
          .where(eq(usagePackSubscriptions.id, candidate.id));
        signal.throwIfAborted();
      }
      return { reconciled: 0, orgIds: [] };
    }
    subscriptionId = stripeObjectId(session.subscription);
    if (!subscriptionId) {
      throw new Error(
        `Completed usage pack Checkout Session ${session.id} has no subscription`,
      );
    }
    const checkoutSubscription = (await stripe.subscriptions.retrieve(
      subscriptionId,
    )) as UsagePackSubscriptionInput;
    signal.throwIfAborted();
    const checkoutOutcome = await handleUsagePackCheckoutCompleted(
      db,
      session,
      checkoutSubscription,
    );
    if (!checkoutOutcome.handled) {
      throw new Error(
        `Usage pack Checkout Session ${session.id} lost its local correlation`,
      );
    }
    if (checkoutOutcome.orgId) {
      orgIds.add(checkoutOutcome.orgId);
    }
  }
  if (!subscriptionId) {
    return { reconciled: 0, orgIds: [...orgIds] };
  }

  const subscription = (await stripe.subscriptions.retrieve(
    subscriptionId,
  )) as UsagePackSubscriptionInput;
  signal.throwIfAborted();
  const syncOutcome = await handleUsagePackSubscriptionUpdated(
    db,
    subscription,
  );
  if (!syncOutcome.handled) {
    throw new Error(
      `Usage pack subscription ${subscriptionId} lost its local correlation`,
    );
  }
  if (syncOutcome.orgId) {
    orgIds.add(syncOutcome.orgId);
  }
  if (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  ) {
    return { reconciled: 0, orgIds: [...orgIds] };
  }

  const invoices = await stripe.invoices.list({
    subscription: subscriptionId,
    status: "paid",
    limit: 1,
  });
  signal.throwIfAborted();
  const invoice = invoices.data[0] as UsagePackInvoiceInput | undefined;
  if (!invoice) {
    return { reconciled: 0, orgIds: [...orgIds] };
  }
  const invoiceOutcome = await handleUsagePackInvoicePaid(db, invoice);
  signal.throwIfAborted();
  if (!invoiceOutcome.handled) {
    throw new Error(
      `Paid usage pack invoice ${invoice.id} lost its local correlation`,
    );
  }
  if (invoiceOutcome.orgId) {
    orgIds.add(invoiceOutcome.orgId);
  }
  return { reconciled: 1, orgIds: [...orgIds] };
}

export async function reconcileUsagePackSubscriptions(
  db: Db,
  signal: AbortSignal,
): Promise<ReconcileUsagePackSubscriptionResult> {
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    return { reconciled: 0, orgIds: [] };
  }
  signal.throwIfAborted();

  const subscriptionChanges = await reconcileUsagePackSubscriptionChanges(
    db,
    signal,
  );
  const allocationChanges = await reconcileUsagePackAllocationChanges(
    db,
    signal,
  );

  const at = nowDate();
  const staleBefore = new Date(
    at.getTime() - USAGE_PACK_RECONCILIATION_DELAY_MS,
  );
  const candidates = await db
    .select()
    .from(usagePackSubscriptions)
    .where(
      or(
        and(
          isNull(usagePackSubscriptions.stripeSubscriptionId),
          isNotNull(usagePackSubscriptions.stripeCheckoutSessionId),
          eq(usagePackSubscriptions.subscriptionStatus, "checkout_pending"),
          lte(usagePackSubscriptions.updatedAt, staleBefore),
        ),
        and(
          isNotNull(usagePackSubscriptions.stripeSubscriptionId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
          ]),
          or(
            and(
              isNull(usagePackSubscriptions.currentPeriodEnd),
              lte(usagePackSubscriptions.updatedAt, staleBefore),
            ),
            lte(usagePackSubscriptions.currentPeriodEnd, at),
            and(
              inArray(usagePackSubscriptions.subscriptionStatus, [
                "past_due",
                "unpaid",
              ]),
              lte(usagePackSubscriptions.updatedAt, staleBefore),
            ),
          ),
        ),
      ),
    )
    .limit(100);
  signal.throwIfAborted();

  const stripe = getStripeClient();
  const orgIds = new Set([
    ...subscriptionChanges.orgIds,
    ...allocationChanges.orgIds,
  ]);
  let reconciled =
    subscriptionChanges.reconciled + allocationChanges.reconciled;
  for (const candidate of candidates) {
    const result = await reconcileUsagePackSubscriptionCandidate(
      db,
      stripe,
      candidate,
      signal,
    );
    reconciled += result.reconciled;
    for (const orgId of result.orgIds) {
      orgIds.add(orgId);
    }
  }
  return { reconciled, orgIds: [...orgIds] };
}
