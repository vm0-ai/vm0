import type {
  MemberUsagePack,
  UsagePackChangeConfirmResponse,
  UsagePackSubscriptionChangePreviewResponse,
  UsagePackUsd,
} from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackSubscriptionChanges,
  usagePackSubscriptions,
} from "@vm0/db/schema/usage-pack-subscription";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripeInvoice,
  type StripeInvoiceCreatePreviewParams,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import {
  calculateUsagePackAdditionCreditGrant,
  calculateUsagePackUpgradeCreditGrants,
  fulfillUsagePackSubscriptionChangeInvoice,
  reconcileUsagePackAllocationChangeSubscription,
  type UsagePackChangeInvoiceInput,
} from "./usage-pack-allocation-change.service";
import {
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  tierForKnownPriceId,
  usagePackUsdForKnownPriceId,
} from "./zero-billing-checkout.service";

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const PAYMENT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const OPEN_ALLOCATION_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
] as const;
const OPEN_SUBSCRIPTION_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
] as const;
const PROJECTED_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
] as const;
const TERMINAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

type UsagePackTier = "pro" | "team";
type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;
type UsagePackAllocationChangeRow =
  typeof usagePackAllocationChanges.$inferSelect;
type UsagePackAllocationChangeInsert =
  typeof usagePackAllocationChanges.$inferInsert;
type UsagePackSubscriptionChangeRow =
  typeof usagePackSubscriptionChanges.$inferSelect;
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface UsagePackSubscriptionChangeContext {
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
  readonly openAllocationChanges: readonly UsagePackAllocationChangeRow[];
  readonly openSubscriptionChanges: readonly {
    readonly id: string;
    readonly status: UsagePackSubscriptionChangeRow["status"];
  }[];
}

type PreparedAllocationChange =
  | {
      readonly kind: "addition";
      readonly userId: string;
      readonly targetUsagePackUsd: UsagePackUsd;
      readonly targetStripePriceId: string;
    }
  | {
      readonly kind: "upgrade" | "downgrade";
      readonly source: UsagePackAllocationRow;
      readonly targetUsagePackUsd: UsagePackUsd;
      readonly targetStripePriceId: string;
    };

interface PreparedSubscriptionChange {
  readonly context: UsagePackSubscriptionChangeContext;
  readonly subscription: StripeSubscription;
  readonly planItem: StripeSubscriptionItem;
  readonly targetPlanPriceId: string;
  readonly allocationChanges: readonly PreparedAllocationChange[];
  readonly period: { readonly start: number; readonly end: number };
  readonly prorationTimestamp: number;
  readonly hasImmediateChanges: boolean;
  readonly hasScheduledChanges: boolean;
  readonly existingScheduleId: string | null;
}

interface PersistSubscriptionChangePreviewArgs {
  readonly prepared: PreparedSubscriptionChange;
  readonly targetTier: UsagePackTier;
  readonly immediateAmountCents: number;
  readonly nextRecurringAmountCents: number;
  readonly currency: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly effectiveAt: Date;
}

type UsagePackSubscriptionChangeInvoiceInput = UsagePackChangeInvoiceInput;

type UsagePackSubscriptionChangePreviewResult =
  | {
      readonly status: "ready";
      readonly preview: UsagePackSubscriptionChangePreviewResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "same_configuration" }
  | { readonly status: "invalid_members" }
  | { readonly status: "conflict" };

type UsagePackSubscriptionChangeConfirmResult =
  | {
      readonly status: "confirmed";
      readonly response: UsagePackChangeConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "conflict" };

type UsagePackSubscriptionChangeInvoiceOutcome =
  | { readonly handled: false; readonly orgId: null }
  | {
      readonly handled: true;
      readonly orgId: string;
      readonly subscription: StripeSubscription;
    };

export async function usagePackSubscriptionChangeSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('public.usage_pack_subscription_changes') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

export async function usagePackMemberAdditionSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available: sql`EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = to_regclass('public.usage_pack_allocation_changes')
            AND attname = 'source_allocation_id'
            AND NOT attnotnull
        )`.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

async function loadUsagePackSubscriptionChangeContext(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<UsagePackSubscriptionChangeContext | null> {
  const [subscription] = await db
    .select()
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.orgId, orgId),
        isNotNull(usagePackSubscriptions.stripeSubscriptionId),
        notInArray(usagePackSubscriptions.subscriptionStatus, [
          ...TERMINAL_SUBSCRIPTION_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptions.updatedAt))
    .limit(1);
  if (!subscription) {
    return null;
  }
  const [allocations, openAllocationChanges, openSubscriptionChanges] =
    await Promise.all([
      db
        .select()
        .from(usagePackAllocations)
        .where(
          eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
        ),
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(
          and(
            eq(
              usagePackAllocationChanges.usagePackSubscriptionId,
              subscription.id,
            ),
            inArray(usagePackAllocationChanges.status, [
              ...OPEN_ALLOCATION_CHANGE_STATUSES,
            ]),
            or(
              isNull(usagePackAllocationChanges.subscriptionChangeId),
              ne(usagePackAllocationChanges.status, "previewed"),
            ),
          ),
        ),
      db
        .select({
          id: usagePackSubscriptionChanges.id,
          status: usagePackSubscriptionChanges.status,
        })
        .from(usagePackSubscriptionChanges)
        .where(
          and(
            eq(
              usagePackSubscriptionChanges.usagePackSubscriptionId,
              subscription.id,
            ),
            inArray(usagePackSubscriptionChanges.status, [
              ...OPEN_SUBSCRIPTION_CHANGE_STATUSES,
            ]),
          ),
        )
        .limit(1),
    ]);
  return {
    subscription,
    allocations,
    openAllocationChanges,
    openSubscriptionChanges,
  };
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function isProjectedAllocation(allocation: UsagePackAllocationRow): boolean {
  return PROJECTED_ALLOCATION_STATUSES.some((status) => {
    return allocation.status === status;
  });
}

function activeMemberAllocations(
  allocations: readonly UsagePackAllocationRow[],
): readonly UsagePackAllocationRow[] {
  return allocations.filter((allocation) => {
    return allocation.status === "active" && allocation.userId !== null;
  });
}

function packageQuantitiesFromAllocations(
  allocations: readonly UsagePackAllocationRow[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const allocation of allocations) {
    if (!isProjectedAllocation(allocation)) {
      continue;
    }
    quantities.set(
      allocation.stripePriceId,
      (quantities.get(allocation.stripePriceId) ?? 0) + 1,
    );
  }
  return quantities;
}

function packageQuantitiesFromSubscription(
  subscription: StripeSubscription,
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(
        `Usage pack subscription item ${item.price.id} has an invalid quantity`,
      );
    }
    quantities.set(
      item.price.id,
      (quantities.get(item.price.id) ?? 0) + quantity,
    );
  }
  return quantities;
}

function quantitiesMatch(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([priceId, quantity]) => {
      return right.get(priceId) === quantity;
    })
  );
}

function currentPlanItem(
  context: UsagePackSubscriptionChangeContext,
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  const planItem = subscriptionPlanItem(subscription);
  if (
    planItem.price.id !== context.subscription.stripePlanPriceId ||
    tierForKnownPriceId(planItem.price.id) !== context.subscription.tier
  ) {
    throw new Error("Stripe usage pack plan is out of sync");
  }
  return planItem;
}

function subscriptionPlanItem(
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  const planItems = subscription.items.data.filter((item) => {
    return isUsagePackPlanPriceId(item.price.id);
  });
  const planItem = planItems[0];
  if (planItems.length !== 1 || !planItem || (planItem.quantity ?? 1) !== 1) {
    throw new Error("Stripe usage pack subscription has an invalid base plan");
  }
  return planItem;
}

function subscriptionPlanTier(subscription: StripeSubscription): UsagePackTier {
  const tier = tierForKnownPriceId(subscriptionPlanItem(subscription).price.id);
  if (!tier) {
    throw new Error("Stripe usage pack subscription has an invalid base plan");
  }
  return tier;
}

function validateStripeSubscription(
  context: UsagePackSubscriptionChangeContext,
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  if (
    subscription.id !== context.subscription.stripeSubscriptionId ||
    stripeObjectId(subscription.customer) !==
      context.subscription.stripeCustomerId
  ) {
    throw new Error("Stripe subscription does not match the usage pack record");
  }
  if (
    !quantitiesMatch(
      packageQuantitiesFromAllocations(context.allocations),
      packageQuantitiesFromSubscription(subscription),
    )
  ) {
    throw new Error("Stripe usage pack quantities are out of sync");
  }
  return currentPlanItem(context, subscription);
}

function usagePackPeriod(subscription: StripeSubscription): {
  readonly start: number;
  readonly end: number;
} {
  const packageItems = subscription.items.data.filter((item) => {
    return usagePackUsdForKnownPriceId(item.price.id) !== null;
  });
  const first = packageItems[0];
  const start = first?.current_period_start;
  const end = first?.current_period_end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    packageItems.some((item) => {
      return (
        item.current_period_start !== start || item.current_period_end !== end
      );
    })
  ) {
    throw new Error("Usage pack subscription has an invalid billing period");
  }
  return { start, end };
}

function memberSelectionsMatch(
  selections: readonly MemberUsagePack[],
  allocations: readonly UsagePackAllocationRow[],
): boolean {
  const selectedIds = new Set(
    selections.map((selection) => {
      return selection.memberId;
    }),
  );
  return (
    selectedIds.size === selections.length &&
    allocations.every((allocation) => {
      return allocation.userId !== null && selectedIds.has(allocation.userId);
    })
  );
}

function allocationSnapshotsMatch(
  expected: readonly UsagePackAllocationRow[],
  actual: readonly UsagePackAllocationRow[],
): boolean {
  if (expected.length !== actual.length) {
    return false;
  }
  const actualById = new Map(
    actual.map((allocation) => {
      return [allocation.id, allocation] as const;
    }),
  );
  return expected.every((allocation) => {
    const current = actualById.get(allocation.id);
    return (
      current?.status === allocation.status &&
      current.userId === allocation.userId &&
      current.invitationId === allocation.invitationId &&
      current.usagePackUsd === allocation.usagePackUsd &&
      current.stripePriceId === allocation.stripePriceId
    );
  });
}

function prepareAllocationChanges(
  selections: readonly MemberUsagePack[],
  allocations: readonly UsagePackAllocationRow[],
): readonly PreparedAllocationChange[] | null {
  if (!memberSelectionsMatch(selections, allocations)) {
    return null;
  }
  const allocationsByMember = new Map(
    allocations.map((allocation) => {
      if (!allocation.userId) {
        throw new Error("Usage pack allocation has no member");
      }
      return [allocation.userId, allocation] as const;
    }),
  );
  return selections.flatMap(
    (selection): readonly PreparedAllocationChange[] => {
      const source = allocationsByMember.get(selection.memberId);
      const targetUsagePackUsd = selection.usagePackUsd;
      const targetStripePriceId = activeUsagePackPriceId(targetUsagePackUsd);
      if (!targetStripePriceId) {
        throw new Error(
          `Usage pack $${targetUsagePackUsd} Price is not configured`,
        );
      }
      if (!source) {
        return [
          {
            kind: "addition",
            userId: selection.memberId,
            targetUsagePackUsd,
            targetStripePriceId,
          },
        ];
      }
      if (targetUsagePackUsd === source.usagePackUsd) {
        return [];
      }
      return [
        {
          source,
          targetUsagePackUsd,
          targetStripePriceId,
          kind:
            targetUsagePackUsd > source.usagePackUsd
              ? ("upgrade" as const)
              : ("downgrade" as const),
        },
      ];
    },
  );
}

function adjustedPackageQuantities(
  allocations: readonly UsagePackAllocationRow[],
  changes: readonly PreparedAllocationChange[],
  include: (change: PreparedAllocationChange) => boolean,
): ReadonlyMap<string, number> {
  const quantities = new Map(packageQuantitiesFromAllocations(allocations));
  for (const change of changes) {
    if (!include(change)) {
      continue;
    }
    if (change.kind !== "addition") {
      const sourceQuantity = quantities.get(change.source.stripePriceId) ?? 0;
      if (sourceQuantity <= 0) {
        throw new Error("Usage pack source quantity disappeared");
      }
      if (sourceQuantity === 1) {
        quantities.delete(change.source.stripePriceId);
      } else {
        quantities.set(change.source.stripePriceId, sourceQuantity - 1);
      }
    }
    quantities.set(
      change.targetStripePriceId,
      (quantities.get(change.targetStripePriceId) ?? 0) + 1,
    );
  }
  return quantities;
}

function subscriptionUpdateItems(
  subscription: StripeSubscription,
  planItem: StripeSubscriptionItem,
  targetPlanPriceId: string,
  targetPackageQuantities: ReadonlyMap<string, number>,
): StripeSubscriptionUpdateItemParam[] {
  const items: StripeSubscriptionUpdateItemParam[] = [];
  if (planItem.price.id !== targetPlanPriceId) {
    items.push({
      id: planItem.id,
      price: targetPlanPriceId,
      quantity: 1,
    });
  }
  const remaining = new Map(targetPackageQuantities);
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const currentQuantity = item.quantity ?? 1;
    const targetQuantity = remaining.get(item.price.id) ?? 0;
    remaining.delete(item.price.id);
    if (targetQuantity === currentQuantity) {
      continue;
    }
    items.push(
      targetQuantity === 0
        ? { id: item.id, deleted: true }
        : { id: item.id, quantity: targetQuantity },
    );
  }
  for (const [price, quantity] of remaining) {
    items.push({ price, quantity });
  }
  return items;
}

function invoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string" ? price : (price?.id ?? null);
}

function invoiceLineAmountWithTax(line: StripeInvoiceLine): number {
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount + exclusiveTax;
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Stripe invoice line ${line.id} has an invalid amount`);
  }
  return amount;
}

function immediateProrationAmount(
  invoice: StripeInvoice,
  prorationTimestamp: number,
): number {
  const lines = invoice.lines.data.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return (
      line.parent?.subscription_item_details?.proration === true &&
      line.period.start === prorationTimestamp &&
      priceId !== null &&
      (isUsagePackPlanPriceId(priceId) ||
        usagePackUsdForKnownPriceId(priceId) !== null)
    );
  });
  const amount = lines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (lines.length === 0 || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Stripe immediate preview has an invalid amount");
  }
  return amount;
}

function recurringAmount(invoice: StripeInvoice): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error("Stripe recurring preview has an invalid amount");
  }
  return invoice.amount_due;
}

function scheduledSubscriptionRecurringPreviewParams(
  subscription: StripeSubscription,
  items: readonly StripeSchedulePhaseItemParam[],
): StripeInvoiceCreatePreviewParams {
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) {
    throw new Error(`Stripe subscription ${subscription.id} has no customer`);
  }
  return {
    customer: customerId,
    preview_mode: "recurring",
    subscription_details: {
      items: [...items],
    },
  };
}

function planIsUpgrade(source: UsagePackTier, target: UsagePackTier): boolean {
  return source === "pro" && target === "team";
}

function planIsDowngrade(
  source: UsagePackTier,
  target: UsagePackTier,
): boolean {
  return source === "team" && target === "pro";
}

function restorableScheduleId(
  changes: readonly UsagePackAllocationChangeRow[],
): string | null {
  const scheduleId = changes[0]?.stripeScheduleId;
  if (!scheduleId) {
    return null;
  }
  return changes.every((change) => {
    return (
      change.status === "scheduled" &&
      change.kind === "downgrade" &&
      change.stripeScheduleId === scheduleId
    );
  })
    ? scheduleId
    : null;
}

function replacementScheduleId(
  changes: readonly UsagePackAllocationChangeRow[],
): string | null {
  const scheduleId = changes[0]?.stripeScheduleId;
  if (!scheduleId) {
    if (
      changes.some((change) => {
        return change.stripeScheduleId !== null;
      })
    ) {
      throw new Error(
        "Usage pack replacement has inconsistent Stripe schedules",
      );
    }
    return null;
  }
  if (
    !changes.every((change) => {
      return (
        change.kind === "downgrade" && change.stripeScheduleId === scheduleId
      );
    })
  ) {
    throw new Error("Usage pack replacement has inconsistent Stripe schedules");
  }
  return scheduleId;
}

type ExistingSchedulePreparation =
  | { readonly status: "ready"; readonly scheduleId: string | null }
  | { readonly status: "same_configuration" | "conflict" };

function prepareExistingSchedule(args: {
  readonly allocationChanges: readonly PreparedAllocationChange[];
  readonly hasImmediateChanges: boolean;
  readonly openAllocationChanges: readonly UsagePackAllocationChangeRow[];
  readonly sameConfiguration: boolean;
}): ExistingSchedulePreparation {
  if (args.openAllocationChanges.length === 0) {
    return args.sameConfiguration
      ? { status: "same_configuration" }
      : { status: "ready", scheduleId: null };
  }
  const scheduleId = restorableScheduleId(args.openAllocationChanges);
  if (!scheduleId) {
    return { status: "conflict" };
  }
  if (args.sameConfiguration) {
    return { status: "ready", scheduleId };
  }
  const replacesScheduledDowngrade =
    !args.hasImmediateChanges &&
    args.allocationChanges.length > 0 &&
    args.allocationChanges.every((change) => {
      return change.kind === "downgrade";
    });
  return replacesScheduledDowngrade
    ? { status: "ready", scheduleId }
    : { status: "conflict" };
}

async function prepareSubscriptionChange(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly targetTier: UsagePackTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
  },
  signal: AbortSignal,
): Promise<
  | { readonly status: "ready"; readonly prepared: PreparedSubscriptionChange }
  | {
      readonly status:
        | "not_found"
        | "same_configuration"
        | "invalid_members"
        | "conflict";
    }
> {
  const context = await loadUsagePackSubscriptionChangeContext(
    args.db,
    args.orgId,
  );
  if (!context || !context.subscription.stripeSubscriptionId) {
    return { status: "not_found" };
  }
  if (
    context.subscription.cancelAtPeriodEnd ||
    context.openSubscriptionChanges.some((change) => {
      return change.status !== "previewed";
    })
  ) {
    return { status: "conflict" };
  }
  const allocationChanges = prepareAllocationChanges(
    args.memberUsagePacks,
    activeMemberAllocations(context.allocations),
  );
  if (!allocationChanges) {
    return { status: "invalid_members" };
  }
  const sameConfiguration =
    context.subscription.tier === args.targetTier &&
    allocationChanges.length === 0;
  const hasImmediateChanges =
    planIsUpgrade(context.subscription.tier, args.targetTier) ||
    allocationChanges.some((change) => {
      return change.kind === "addition" || change.kind === "upgrade";
    });
  const existingSchedule = prepareExistingSchedule({
    allocationChanges,
    hasImmediateChanges,
    openAllocationChanges: context.openAllocationChanges,
    sameConfiguration,
  });
  if (existingSchedule.status !== "ready") {
    return { status: existingSchedule.status };
  }
  const existingScheduleId = existingSchedule.scheduleId;
  const targetPlanPriceId =
    context.subscription.tier === args.targetTier
      ? context.subscription.stripePlanPriceId
      : activeUsagePackPlanPriceId(args.targetTier);
  if (!targetPlanPriceId) {
    throw new Error(
      `${args.targetTier} usage pack plan Price is not configured`,
    );
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    context.subscription.stripeSubscriptionId,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  const stripeScheduleId = stripeObjectId(subscription.schedule);
  if (
    subscription.pending_update ||
    (existingScheduleId
      ? stripeScheduleId !== existingScheduleId
      : stripeScheduleId !== null)
  ) {
    return { status: "conflict" };
  }
  const planItem = validateStripeSubscription(context, subscription);
  const period = usagePackPeriod(subscription);
  const requestedTimestamp = Math.floor(nowDate().getTime() / 1000);
  const prorationTimestamp = Math.min(
    Math.max(requestedTimestamp, period.start),
    period.end - 1,
  );
  return {
    status: "ready",
    prepared: {
      context,
      subscription,
      planItem,
      targetPlanPriceId,
      allocationChanges,
      period,
      prorationTimestamp,
      hasImmediateChanges,
      hasScheduledChanges:
        planIsDowngrade(context.subscription.tier, args.targetTier) ||
        allocationChanges.some((change) => {
          return change.kind === "downgrade";
        }),
      existingScheduleId,
    },
  };
}

async function lockUsagePackBillingOrg(
  tx: Pick<WriteTx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage_pack_billing:${orgId}`}, 0))`,
  );
}

async function failExpiredPreviews(
  tx: WriteTx,
  orgId: string,
  at: Date,
): Promise<void> {
  const expiredRoots = await tx
    .update(usagePackSubscriptionChanges)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackSubscriptionChanges.orgId, orgId),
        eq(usagePackSubscriptionChanges.status, "previewed"),
        lte(usagePackSubscriptionChanges.previewExpiresAt, at),
      ),
    )
    .returning({ id: usagePackSubscriptionChanges.id });
  if (expiredRoots.length > 0) {
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        inArray(
          usagePackAllocationChanges.subscriptionChangeId,
          expiredRoots.map((root) => {
            return root.id;
          }),
        ),
      );
  }
  await tx
    .update(usagePackAllocationChanges)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackAllocationChanges.orgId, orgId),
        eq(usagePackAllocationChanges.status, "previewed"),
        lte(usagePackAllocationChanges.previewExpiresAt, at),
      ),
    );
}

async function supersedePreviewedSubscriptionChanges(
  tx: WriteTx,
  orgId: string,
  at: Date,
): Promise<void> {
  const superseded = await tx
    .update(usagePackSubscriptionChanges)
    .set({
      status: "failed",
      failureReason: "preview_superseded",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackSubscriptionChanges.orgId, orgId),
        eq(usagePackSubscriptionChanges.status, "previewed"),
      ),
    )
    .returning({ id: usagePackSubscriptionChanges.id });
  if (superseded.length === 0) {
    return;
  }
  await tx
    .update(usagePackAllocationChanges)
    .set({
      status: "failed",
      failureReason: "preview_superseded",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      inArray(
        usagePackAllocationChanges.subscriptionChangeId,
        superseded.map((root) => {
          return root.id;
        }),
      ),
    );
}

async function subscriptionChangeSnapshotMatches(
  tx: WriteTx,
  prepared: PreparedSubscriptionChange,
): Promise<boolean> {
  const { context } = prepared;
  const [lockedSubscription] = await tx
    .select()
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.id, context.subscription.id))
    .for("update")
    .limit(1);
  if (
    !lockedSubscription ||
    lockedSubscription.tier !== context.subscription.tier ||
    lockedSubscription.stripePlanPriceId !==
      context.subscription.stripePlanPriceId ||
    lockedSubscription.cancelAtPeriodEnd
  ) {
    return false;
  }
  const [openAllocation, openSubscription] = await Promise.all([
    tx
      .select()
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(
            usagePackAllocationChanges.usagePackSubscriptionId,
            context.subscription.id,
          ),
          inArray(usagePackAllocationChanges.status, [
            ...OPEN_ALLOCATION_CHANGE_STATUSES,
          ]),
        ),
      ),
    tx
      .select({ id: usagePackSubscriptionChanges.id })
      .from(usagePackSubscriptionChanges)
      .where(
        and(
          eq(
            usagePackSubscriptionChanges.usagePackSubscriptionId,
            context.subscription.id,
          ),
          inArray(usagePackSubscriptionChanges.status, [
            ...OPEN_SUBSCRIPTION_CHANGE_STATUSES,
          ]),
        ),
      )
      .limit(1),
  ]);
  const expectedOpenAllocationIds = new Set(
    context.openAllocationChanges.map((change) => {
      return change.id;
    }),
  );
  const openAllocationMatches = prepared.existingScheduleId
    ? openAllocation.length === expectedOpenAllocationIds.size &&
      openAllocation.every((change) => {
        return (
          expectedOpenAllocationIds.has(change.id) &&
          change.status === "scheduled" &&
          change.kind === "downgrade" &&
          change.stripeScheduleId === prepared.existingScheduleId
        );
      })
    : openAllocation.length === 0;
  if (!openAllocationMatches || openSubscription.length > 0) {
    return false;
  }
  const lockedAllocations = await tx
    .select()
    .from(usagePackAllocations)
    .where(
      eq(usagePackAllocations.usagePackSubscriptionId, context.subscription.id),
    )
    .for("update");
  return allocationSnapshotsMatch(context.allocations, lockedAllocations);
}

function allocationChangePreviewValue(
  change: PreparedAllocationChange,
  rootId: string,
  args: PersistSubscriptionChangePreviewArgs,
): UsagePackAllocationChangeInsert {
  const userId =
    change.kind === "addition" ? change.userId : change.source.userId;
  if (!userId) {
    throw new Error("Usage pack allocation change has no member");
  }
  const { context } = args.prepared;
  return {
    usagePackSubscriptionId: context.subscription.id,
    subscriptionChangeId: rootId,
    orgId: context.subscription.orgId,
    userId,
    sourceAllocationId: change.kind === "addition" ? null : change.source.id,
    kind: change.kind,
    sourceUsagePackUsd:
      change.kind === "addition" ? null : change.source.usagePackUsd,
    sourceStripePriceId:
      change.kind === "addition" ? null : change.source.stripePriceId,
    targetUsagePackUsd: change.targetUsagePackUsd,
    targetStripePriceId: change.targetStripePriceId,
    prorationTimestamp: args.prepared.prorationTimestamp,
    immediateAmountCents: null,
    nextRecurringAmountCents: null,
    currency: args.currency,
    stripeScheduleId: args.prepared.existingScheduleId,
    effectiveAt:
      change.kind === "addition" || change.kind === "upgrade"
        ? new Date(args.prepared.prorationTimestamp * 1000)
        : new Date(args.prepared.period.end * 1000),
    previewExpiresAt: args.expiresAt,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

async function insertSubscriptionChangePreview(
  tx: WriteTx,
  args: PersistSubscriptionChangePreviewArgs,
): Promise<UsagePackSubscriptionChangeRow> {
  const { context } = args.prepared;
  const [root] = await tx
    .insert(usagePackSubscriptionChanges)
    .values({
      usagePackSubscriptionId: context.subscription.id,
      orgId: context.subscription.orgId,
      sourceTier: context.subscription.tier,
      targetTier: args.targetTier,
      prorationTimestamp: args.prepared.prorationTimestamp,
      immediateAmountCents: args.immediateAmountCents,
      nextRecurringAmountCents: args.nextRecurringAmountCents,
      currency: args.currency,
      previewExpiresAt: args.expiresAt,
      effectiveAt: args.effectiveAt,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .returning();
  if (!root) {
    throw new Error("Failed to persist usage pack subscription preview");
  }
  if (args.prepared.allocationChanges.length > 0) {
    await tx.insert(usagePackAllocationChanges).values(
      args.prepared.allocationChanges.map((change) => {
        return allocationChangePreviewValue(change, root.id, args);
      }),
    );
  }
  return root;
}

async function persistSubscriptionChangePreview(
  db: Db,
  args: PersistSubscriptionChangePreviewArgs,
): Promise<UsagePackSubscriptionChangeRow | null> {
  return await db.transaction(async (tx) => {
    const { context } = args.prepared;
    await lockUsagePackBillingOrg(tx, context.subscription.orgId);
    await failExpiredPreviews(tx, context.subscription.orgId, args.createdAt);
    await supersedePreviewedSubscriptionChanges(
      tx,
      context.subscription.orgId,
      args.createdAt,
    );
    if (!(await subscriptionChangeSnapshotMatches(tx, args.prepared))) {
      return null;
    }
    return await insertSubscriptionChangePreview(tx, args);
  });
}

async function immediateUsagePackUpgradeCreditGrant(
  prepared: PreparedSubscriptionChange,
): Promise<{
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly totalCredits: number;
  readonly expiresAt: string;
}> {
  const inputs = prepared.allocationChanges.flatMap((change) => {
    return change.kind === "upgrade"
      ? [
          {
            sourceAllocation: change.source,
            sourceStripePriceId: change.source.stripePriceId,
            targetStripePriceId: change.targetStripePriceId,
          },
        ]
      : [];
  });
  const grants = await calculateUsagePackUpgradeCreditGrants(inputs, {
    start: prepared.prorationTimestamp,
    end: prepared.period.end,
  });
  const additionGrants = await Promise.all(
    prepared.allocationChanges.flatMap((change) => {
      return change.kind === "addition"
        ? [
            calculateUsagePackAdditionCreditGrant(
              change.targetStripePriceId,
              prepared.period,
              prepared.prorationTimestamp,
            ),
          ]
        : [];
    }),
  );
  let purchasedCredits = 0;
  let bonusCredits = 0;
  for (const grant of [...grants, ...additionGrants]) {
    purchasedCredits += grant.purchasedCredits;
    bonusCredits += grant.bonusCredits;
  }
  const totalCredits = purchasedCredits + bonusCredits;
  if (
    !Number.isSafeInteger(purchasedCredits) ||
    !Number.isSafeInteger(bonusCredits) ||
    !Number.isSafeInteger(totalCredits)
  ) {
    throw new Error("Usage pack upgrade credits are too large");
  }
  return {
    purchasedCredits,
    bonusCredits,
    totalCredits,
    expiresAt: new Date(prepared.period.end * 1000).toISOString(),
  };
}

export async function previewUsagePackSubscriptionChange(
  db: Db,
  args: {
    readonly orgId: string;
    readonly targetTier: UsagePackTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
  },
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangePreviewResult> {
  const result = await prepareSubscriptionChange({ db, ...args }, signal);
  if (result.status !== "ready") {
    return result;
  }
  const { prepared } = result;
  const immediatePackageQuantities = adjustedPackageQuantities(
    prepared.context.allocations,
    prepared.allocationChanges,
    (change) => {
      return change.kind === "addition" || change.kind === "upgrade";
    },
  );
  const finalPackageQuantities = adjustedPackageQuantities(
    prepared.context.allocations,
    prepared.allocationChanges,
    () => {
      return true;
    },
  );
  const immediatePlanPriceId = planIsUpgrade(
    prepared.context.subscription.tier,
    args.targetTier,
  )
    ? prepared.targetPlanPriceId
    : prepared.context.subscription.stripePlanPriceId;
  const immediateItems = subscriptionUpdateItems(
    prepared.subscription,
    prepared.planItem,
    immediatePlanPriceId,
    immediatePackageQuantities,
  );
  const finalItems = subscriptionUpdateItems(
    prepared.subscription,
    prepared.planItem,
    prepared.targetPlanPriceId,
    finalPackageQuantities,
  );
  const stripe = getStripeClient();
  const [recurringPreview, immediatePreview, immediateCreditGrant] =
    await Promise.all([
      stripe.invoices.createPreview(
        prepared.existingScheduleId
          ? scheduledSubscriptionRecurringPreviewParams(
              prepared.subscription,
              finalScheduleItems(
                prepared.subscription,
                prepared.targetPlanPriceId,
                finalPackageQuantities,
              ),
            )
          : {
              subscription: prepared.subscription.id,
              preview_mode: "recurring",
              subscription_details: { items: finalItems },
            },
      ),
      prepared.hasImmediateChanges
        ? stripe.invoices.createPreview({
            subscription: prepared.subscription.id,
            preview_mode: "next",
            subscription_details: {
              items: immediateItems,
              proration_behavior: "always_invoice",
              proration_date: prepared.prorationTimestamp,
            },
          })
        : null,
      immediateUsagePackUpgradeCreditGrant(prepared),
    ]);
  signal.throwIfAborted();
  if (
    immediatePreview &&
    recurringPreview.currency !== immediatePreview.currency
  ) {
    throw new Error(
      "Stripe subscription previews returned different currencies",
    );
  }
  const createdAt = nowDate();
  const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS);
  const effectiveAt = new Date(
    (planIsDowngrade(prepared.context.subscription.tier, args.targetTier) ||
    (!prepared.hasImmediateChanges && prepared.hasScheduledChanges)
      ? prepared.period.end
      : prepared.prorationTimestamp) * 1000,
  );
  const immediateAmountCents = immediatePreview
    ? immediateProrationAmount(immediatePreview, prepared.prorationTimestamp)
    : 0;
  const nextRecurringAmountCents = recurringAmount(recurringPreview);
  const change = await persistSubscriptionChangePreview(db, {
    prepared,
    targetTier: args.targetTier,
    immediateAmountCents,
    nextRecurringAmountCents,
    currency: recurringPreview.currency,
    createdAt,
    expiresAt,
    effectiveAt,
  });
  if (!change) {
    return { status: "conflict" };
  }
  return {
    status: "ready",
    preview: {
      changeId: change.id,
      sourceTier: change.sourceTier,
      targetTier: change.targetTier,
      immediateAmountCents,
      immediateCreditGrant,
      nextRecurringAmountCents,
      currency: recurringPreview.currency,
      effectiveAt: effectiveAt.toISOString(),
      prorationDate: new Date(prepared.prorationTimestamp * 1000).toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  };
}

function subscriptionPhaseItems(
  subscription: StripeSubscription,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return { price: item.price.id, quantity: item.quantity ?? 1 };
  });
}

function subscriptionPhaseDiscounts(
  subscription: StripeSubscription,
): StripeSchedulePhaseDiscountParam[] {
  return (subscription.discounts ?? []).flatMap((discount) => {
    const id = stripeObjectId(discount);
    return id ? [{ discount: id }] : [];
  });
}

function phaseWithDiscounts(
  phase: StripeSchedulePhaseParam,
  discounts: readonly StripeSchedulePhaseDiscountParam[],
): StripeSchedulePhaseParam {
  return discounts.length === 0
    ? phase
    : { ...phase, discounts: [...discounts] };
}

function subscriptionRecurringDuration(
  subscription: StripeSubscription,
): StripePriceRecurring {
  const recurring = subscription.items.data.find((item) => {
    return isUsagePackPlanPriceId(item.price.id);
  })?.price.recurring;
  if (!recurring) {
    throw new Error("Usage pack base plan is not recurring");
  }
  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function projectedPackageQuantities(
  allocations: readonly UsagePackAllocationRow[],
  changes: readonly UsagePackAllocationChangeRow[],
  include: (change: UsagePackAllocationChangeRow) => boolean,
): ReadonlyMap<string, number> {
  const priceByMember = new Map<string, string>();
  for (const allocation of allocations) {
    if (allocation.userId && isProjectedAllocation(allocation)) {
      priceByMember.set(allocation.userId, allocation.stripePriceId);
    }
  }
  for (const change of changes) {
    if (!include(change)) {
      continue;
    }
    if (!change.targetStripePriceId) {
      throw new Error(`Subscription change ${change.id} has no target Price`);
    }
    priceByMember.set(change.userId, change.targetStripePriceId);
  }
  const quantities = new Map<string, number>();
  for (const priceId of priceByMember.values()) {
    quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
  }
  for (const allocation of allocations) {
    if (allocation.invitationId && isProjectedAllocation(allocation)) {
      quantities.set(
        allocation.stripePriceId,
        (quantities.get(allocation.stripePriceId) ?? 0) + 1,
      );
    }
  }
  return quantities;
}

function finalScheduleItems(
  subscription: StripeSubscription,
  targetPlanPriceId: string,
  quantities: ReadonlyMap<string, number>,
): StripeSchedulePhaseItemParam[] {
  const unrelated = subscription.items.data
    .filter((item) => {
      return (
        !isUsagePackPlanPriceId(item.price.id) &&
        usagePackUsdForKnownPriceId(item.price.id) === null
      );
    })
    .map((item) => {
      return { price: item.price.id, quantity: item.quantity ?? 1 };
    });
  return [
    ...unrelated,
    { price: targetPlanPriceId, quantity: 1 },
    ...[...quantities].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

async function loadStoredSubscriptionChange(
  db: Pick<Db, "select">,
  changeId: string,
): Promise<{
  readonly root: UsagePackSubscriptionChangeRow;
  readonly allocationChanges: readonly UsagePackAllocationChangeRow[];
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
} | null> {
  const [root] = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(eq(usagePackSubscriptionChanges.id, changeId))
    .limit(1);
  if (!root) {
    return null;
  }
  const [allocationChanges, subscriptions, allocations] = await Promise.all([
    db
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id)),
    db
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, root.usagePackSubscriptionId))
      .limit(1),
    db
      .select()
      .from(usagePackAllocations)
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          root.usagePackSubscriptionId,
        ),
      ),
  ]);
  const subscription = subscriptions[0];
  if (!subscription) {
    throw new Error(`Subscription change ${root.id} lost its subscription`);
  }
  return { root, allocationChanges, subscription, allocations };
}

async function persistDeferredSubscriptionChangeSchedule(
  db: Db,
  stored: NonNullable<Awaited<ReturnType<typeof loadStoredSubscriptionChange>>>,
  scheduleId: string,
  effectiveAt: Date,
): Promise<void> {
  const updatedAt = nowDate();
  const supersededScheduleId = replacementScheduleId(stored.allocationChanges);
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, stored.root.orgId);
    if (supersededScheduleId) {
      const superseded = await tx
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "scheduled_change_superseded",
          completedAt: updatedAt,
          updatedAt,
        })
        .where(
          and(
            eq(
              usagePackAllocationChanges.usagePackSubscriptionId,
              stored.subscription.id,
            ),
            eq(usagePackAllocationChanges.status, "scheduled"),
            eq(
              usagePackAllocationChanges.stripeScheduleId,
              supersededScheduleId,
            ),
          ),
        )
        .returning({ id: usagePackAllocationChanges.id });
      if (superseded.length === 0) {
        throw new Error("Scheduled usage pack replacement lost its source");
      }
    }
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "scheduled",
        stripeScheduleId: scheduleId,
        effectiveAt,
        updatedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.subscriptionChangeId, stored.root.id),
          eq(usagePackAllocationChanges.kind, "downgrade"),
          inArray(usagePackAllocationChanges.status, [
            "applying",
            "pending_payment",
          ]),
        ),
      );
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "completed",
        effectiveAt,
        completedAt: updatedAt,
        updatedAt,
      })
      .where(eq(usagePackSubscriptionChanges.id, stored.root.id));
    if (planIsDowngrade(stored.root.sourceTier, stored.root.targetTier)) {
      await tx
        .update(orgMetadata)
        .set({
          cancelAtPeriodEnd: false,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: stored.root.targetTier,
          pendingSubscriptionChangeAt: effectiveAt,
          currentPeriodEnd: effectiveAt,
          updatedAt,
        })
        .where(eq(orgMetadata.orgId, stored.root.orgId));
    }
  });
}

async function scheduleDeferredSubscriptionChange(
  db: Db,
  stored: NonNullable<Awaited<ReturnType<typeof loadStoredSubscriptionChange>>>,
  subscription: StripeSubscription,
  signal: AbortSignal | undefined,
): Promise<Date> {
  const period = usagePackPeriod(subscription);
  const targetPlanPriceId =
    stored.root.sourceTier === stored.root.targetTier
      ? stored.subscription.stripePlanPriceId
      : activeUsagePackPlanPriceId(stored.root.targetTier);
  if (!targetPlanPriceId) {
    throw new Error(
      `${stored.root.targetTier} usage pack plan Price is not configured`,
    );
  }
  const quantities = projectedPackageQuantities(
    stored.allocations,
    stored.allocationChanges,
    () => {
      return true;
    },
  );
  if (quantities.size === 0) {
    throw new Error("A usage pack subscription cannot have no packages");
  }
  const stripe = getStripeClient();
  const existingScheduleId = stripeObjectId(subscription.schedule);
  const createdSchedule = existingScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: subscription.id },
        {
          idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:schedule-create`,
        },
      );
  signal?.throwIfAborted();
  const scheduleId = existingScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a subscription schedule ID");
  }
  const discounts = subscriptionPhaseDiscounts(subscription);
  await stripe.subscriptionSchedules.update(
    scheduleId,
    {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        phaseWithDiscounts(
          {
            start_date: period.start,
            end_date: period.end,
            items: subscriptionPhaseItems(subscription),
            proration_behavior: "none",
          },
          discounts,
        ),
        phaseWithDiscounts(
          {
            start_date: period.end,
            duration: subscriptionRecurringDuration(subscription),
            items: finalScheduleItems(
              subscription,
              targetPlanPriceId,
              quantities,
            ),
            proration_behavior: "none",
          },
          discounts,
        ),
      ],
    },
    {
      idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:schedule-update`,
    },
  );
  signal?.throwIfAborted();
  const effectiveAt = new Date(period.end * 1000);
  await persistDeferredSubscriptionChangeSchedule(
    db,
    stored,
    scheduleId,
    effectiveAt,
  );
  return effectiveAt;
}

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

async function markPreparedChangeApplying(
  db: Db,
  orgId: string,
  changeId: string,
): Promise<UsagePackSubscriptionChangeRow | null> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, orgId);
    const [root] = await tx
      .select()
      .from(usagePackSubscriptionChanges)
      .where(
        and(
          eq(usagePackSubscriptionChanges.id, changeId),
          eq(usagePackSubscriptionChanges.orgId, orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!root || root.status !== "previewed") {
      return null;
    }
    const at = nowDate();
    if (root.previewExpiresAt <= at) {
      await tx
        .update(usagePackSubscriptionChanges)
        .set({
          status: "failed",
          failureReason: "preview_expired",
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(usagePackSubscriptionChanges.id, root.id));
      await tx
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "preview_expired",
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id));
      return null;
    }
    const [updated] = await tx
      .update(usagePackSubscriptionChanges)
      .set({ status: "applying", updatedAt: at })
      .where(eq(usagePackSubscriptionChanges.id, root.id))
      .returning();
    await tx
      .update(usagePackAllocationChanges)
      .set({ status: "applying", updatedAt: at })
      .where(
        and(
          eq(usagePackAllocationChanges.subscriptionChangeId, root.id),
          eq(usagePackAllocationChanges.status, "previewed"),
        ),
      );
    return updated ?? null;
  });
}

async function failApplyingSubscriptionChange(
  db: Db,
  root: UsagePackSubscriptionChangeRow,
  failureReason: string,
): Promise<void> {
  const completedAt = nowDate();
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, root.orgId);
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "failed",
        failureReason,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionChanges.id, root.id),
          eq(usagePackSubscriptionChanges.status, "applying"),
        ),
      );
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.subscriptionChangeId, root.id),
          eq(usagePackAllocationChanges.status, "applying"),
        ),
      );
  });
}

async function confirmationResponseForStoredChange(
  root: UsagePackSubscriptionChangeRow,
  allocationChanges: readonly UsagePackAllocationChangeRow[],
  signal: AbortSignal,
): Promise<UsagePackChangeConfirmResponse | null> {
  if (root.status === "pending_payment") {
    if (!root.stripeInvoiceId) {
      throw new Error(`Subscription change ${root.id} has no Stripe invoice`);
    }
    const invoice = await getStripeClient().invoices.retrieve(
      root.stripeInvoiceId,
    );
    signal.throwIfAborted();
    return {
      status: invoice.status === "paid" ? "processing" : "pending_payment",
      effectiveAt: root.effectiveAt.toISOString(),
      hostedInvoiceUrl: null,
    };
  }
  if (root.status === "completed") {
    return {
      status:
        planIsDowngrade(root.sourceTier, root.targetTier) ||
        allocationChanges.some((change) => {
          return change.status === "scheduled";
        })
          ? "scheduled"
          : "completed",
      effectiveAt: root.effectiveAt.toISOString(),
      hostedInvoiceUrl: null,
    };
  }
  return null;
}

type StoredSubscriptionChange = NonNullable<
  Awaited<ReturnType<typeof loadStoredSubscriptionChange>>
>;

type SubscriptionChangeConfirmationPreparation =
  | { readonly ready: true; readonly stored: StoredSubscriptionChange }
  | {
      readonly ready: false;
      readonly result: UsagePackSubscriptionChangeConfirmResult;
    };

async function prepareSubscriptionChangeConfirmation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly changeId: string;
  },
  signal: AbortSignal,
): Promise<SubscriptionChangeConfirmationPreparation> {
  let stored = await loadStoredSubscriptionChange(db, args.changeId);
  if (!stored || stored.root.orgId !== args.orgId) {
    return { ready: false, result: { status: "not_found" } };
  }
  if (stored.root.status === "failed") {
    return {
      ready: false,
      result:
        stored.root.failureReason === "preview_expired"
          ? { status: "expired" }
          : { status: "conflict" },
    };
  }
  if (stored.root.status === "applying") {
    if (!stored.subscription.stripeSubscriptionId) {
      throw new Error("Usage pack subscription disappeared during retry");
    }
    return { ready: true, stored };
  }
  const existing = await confirmationResponseForStoredChange(
    stored.root,
    stored.allocationChanges,
    signal,
  );
  if (existing) {
    return {
      ready: false,
      result: { status: "confirmed", response: existing },
    };
  }
  const applying = await markPreparedChangeApplying(
    db,
    args.orgId,
    args.changeId,
  );
  if (!applying) {
    stored = await loadStoredSubscriptionChange(db, args.changeId);
    return {
      ready: false,
      result:
        stored?.root.failureReason === "preview_expired"
          ? { status: "expired" }
          : { status: "conflict" },
    };
  }
  stored = await loadStoredSubscriptionChange(db, args.changeId);
  if (!stored || !stored.subscription.stripeSubscriptionId) {
    throw new Error("Usage pack subscription disappeared during confirmation");
  }
  return { ready: true, stored };
}

function applyImmediatePackageChanges(
  packageQuantities: Map<string, number>,
  packageChanges: readonly UsagePackAllocationChangeRow[],
): void {
  for (const change of packageChanges) {
    if (!change.targetStripePriceId) {
      throw new Error(`Subscription change ${change.id} has no target Price`);
    }
    if (change.kind !== "addition") {
      if (!change.sourceStripePriceId) {
        throw new Error(`Subscription change ${change.id} has no source Price`);
      }
      const sourceQuantity = packageQuantities.get(change.sourceStripePriceId);
      if (!sourceQuantity) {
        throw new Error(
          `Subscription change ${change.id} lost its source Price`,
        );
      }
      if (sourceQuantity === 1) {
        packageQuantities.delete(change.sourceStripePriceId);
      } else {
        packageQuantities.set(change.sourceStripePriceId, sourceQuantity - 1);
      }
    }
    packageQuantities.set(
      change.targetStripePriceId,
      (packageQuantities.get(change.targetStripePriceId) ?? 0) + 1,
    );
  }
}

async function recordImmediateSubscriptionChangeInvoice(
  db: Db,
  stored: StoredSubscriptionChange,
  invoice: StripeInvoice,
  pendingUpdateExpiresAt: Date | null,
): Promise<void> {
  const pending = pendingUpdateExpiresAt !== null;
  const updatedAt = nowDate();
  await db.transaction(async (tx) => {
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: pending ? "pending_payment" : "applying",
        stripeInvoiceId: invoice.id,
        stripePendingUpdateExpiresAt: pendingUpdateExpiresAt,
        updatedAt,
      })
      .where(eq(usagePackSubscriptionChanges.id, stored.root.id));
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: pending ? "pending_payment" : "applying",
        stripePendingUpdateExpiresAt: pendingUpdateExpiresAt,
        updatedAt,
      })
      .where(
        eq(usagePackAllocationChanges.subscriptionChangeId, stored.root.id),
      );
  });
}

function subscriptionPendingUpdateExpiresAt(
  subscription: StripeSubscription,
): Date | null {
  const expiresAt = subscription.pending_update?.expires_at;
  if (expiresAt === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("Stripe subscription pending update has an invalid expiry");
  }
  return new Date(expiresAt * 1000);
}

async function applyImmediateSubscriptionChange(
  db: Db,
  args: {
    readonly stored: StoredSubscriptionChange;
    readonly subscription: StripeSubscription;
    readonly planItem: StripeSubscriptionItem;
    readonly hasPlanUpgrade: boolean;
    readonly immediatePackageChanges: readonly UsagePackAllocationChangeRow[];
  },
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const packageQuantities = new Map(
    packageQuantitiesFromAllocations(args.stored.allocations),
  );
  applyImmediatePackageChanges(packageQuantities, args.immediatePackageChanges);
  const targetPlanPriceId = args.hasPlanUpgrade
    ? activeUsagePackPlanPriceId("team")
    : args.stored.subscription.stripePlanPriceId;
  if (!targetPlanPriceId) {
    throw new Error("Team usage pack plan Price is not configured");
  }
  const updatedSubscription = await getStripeClient().subscriptions.update(
    args.subscription.id,
    {
      items: subscriptionUpdateItems(
        args.subscription,
        args.planItem,
        targetPlanPriceId,
        packageQuantities,
      ),
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: args.stored.root.prorationTimestamp,
      expand: ["latest_invoice.payment_intent"],
    },
    {
      idempotencyKey: `usage-pack-subscription-change:${args.stored.root.id}:apply`,
    },
  );
  signal.throwIfAborted();
  const invoice = expandedLatestInvoice(updatedSubscription);
  if (!invoice) {
    throw new Error("Stripe did not create a subscription change invoice");
  }
  const pendingUpdateExpiresAt =
    subscriptionPendingUpdateExpiresAt(updatedSubscription);
  const pending = pendingUpdateExpiresAt !== null;
  await recordImmediateSubscriptionChangeInvoice(
    db,
    args.stored,
    invoice,
    pendingUpdateExpiresAt,
  );
  return {
    status: "confirmed",
    response: {
      status: pending ? "pending_payment" : "processing",
      effectiveAt: args.stored.root.effectiveAt.toISOString(),
      hostedInvoiceUrl: null,
    },
  };
}

function isScheduledSubscriptionRestore(
  stored: StoredSubscriptionChange,
): boolean {
  return (
    stored.root.sourceTier === stored.root.targetTier &&
    stored.allocationChanges.length === 0
  );
}

async function restoreScheduledSubscriptionChange(
  db: Db,
  stored: StoredSubscriptionChange,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const scheduledChanges = await db
    .select()
    .from(usagePackAllocationChanges)
    .where(
      and(
        eq(
          usagePackAllocationChanges.usagePackSubscriptionId,
          stored.subscription.id,
        ),
        eq(usagePackAllocationChanges.status, "scheduled"),
      ),
    );
  signal.throwIfAborted();
  const scheduleId = restorableScheduleId(scheduledChanges);
  const stripeScheduleId = stripeObjectId(subscription.schedule);
  if (
    !scheduleId ||
    (stripeScheduleId !== null && stripeScheduleId !== scheduleId)
  ) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "scheduled_restore_conflict",
    );
    return { status: "conflict" };
  }
  if (stripeScheduleId === scheduleId) {
    await getStripeClient().subscriptionSchedules.release(scheduleId);
  }
  const completedAt = nowDate();
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, stored.root.orgId);
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "scheduled_change_restored",
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          inArray(
            usagePackAllocationChanges.id,
            scheduledChanges.map((change) => {
              return change.id;
            }),
          ),
          eq(usagePackAllocationChanges.status, "scheduled"),
        ),
      );
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "completed",
        effectiveAt: completedAt,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionChanges.id, stored.root.id),
          eq(usagePackSubscriptionChanges.status, "applying"),
        ),
      );
    await tx
      .update(orgMetadata)
      .set({
        cancelAtPeriodEnd: false,
        pendingSubscriptionScheduleId: null,
        pendingSubscriptionTargetTier: null,
        pendingSubscriptionChangeAt: null,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(orgMetadata.orgId, stored.root.orgId),
          eq(orgMetadata.pendingSubscriptionScheduleId, scheduleId),
        ),
      );
  });
  return {
    status: "confirmed",
    response: {
      status: "completed",
      effectiveAt: completedAt.toISOString(),
      hostedInvoiceUrl: null,
    },
  };
}

async function applyStoredSubscriptionChange(
  db: Db,
  stored: StoredSubscriptionChange,
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const subscriptionId = stored.subscription.stripeSubscriptionId;
  if (!subscriptionId) {
    throw new Error("Usage pack subscription has no Stripe subscription ID");
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  if (subscription.pending_update) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "stripe_pending_update_conflict",
    );
    return { status: "conflict" };
  }
  const context: UsagePackSubscriptionChangeContext = {
    subscription: stored.subscription,
    allocations: stored.allocations,
    openAllocationChanges: [],
    openSubscriptionChanges: [],
  };
  const planItem = validateStripeSubscription(context, subscription);
  if (isScheduledSubscriptionRestore(stored)) {
    return await restoreScheduledSubscriptionChange(
      db,
      stored,
      subscription,
      signal,
    );
  }
  const supersededScheduleId = replacementScheduleId(stored.allocationChanges);
  if (supersededScheduleId) {
    const scheduledChanges = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(
            usagePackAllocationChanges.usagePackSubscriptionId,
            stored.subscription.id,
          ),
          eq(usagePackAllocationChanges.status, "scheduled"),
        ),
      );
    signal.throwIfAborted();
    if (
      stripeObjectId(subscription.schedule) !== supersededScheduleId ||
      restorableScheduleId(scheduledChanges) !== supersededScheduleId
    ) {
      await failApplyingSubscriptionChange(
        db,
        stored.root,
        "scheduled_replacement_conflict",
      );
      return { status: "conflict" };
    }
  }
  const hasPlanUpgrade = planIsUpgrade(
    stored.root.sourceTier,
    stored.root.targetTier,
  );
  const immediatePackageChanges = stored.allocationChanges.filter((change) => {
    return change.kind === "addition" || change.kind === "upgrade";
  });
  const hasImmediateChanges =
    hasPlanUpgrade || immediatePackageChanges.length > 0;
  const hasScheduledChanges =
    planIsDowngrade(stored.root.sourceTier, stored.root.targetTier) ||
    stored.allocationChanges.some((change) => {
      return change.kind === "downgrade";
    });
  if (!hasImmediateChanges) {
    if (!hasScheduledChanges) {
      throw new Error("Stored usage pack subscription change has no changes");
    }
    const effectiveAt = await scheduleDeferredSubscriptionChange(
      db,
      stored,
      subscription,
      signal,
    );
    return {
      status: "confirmed",
      response: {
        status: "scheduled",
        effectiveAt: effectiveAt.toISOString(),
        hostedInvoiceUrl: null,
      },
    };
  }
  return await applyImmediateSubscriptionChange(
    db,
    {
      stored,
      subscription,
      planItem,
      hasPlanUpgrade,
      immediatePackageChanges,
    },
    signal,
  );
}

export async function confirmUsagePackSubscriptionChange(
  db: Db,
  args: {
    readonly orgId: string;
    readonly changeId: string;
  },
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const preparation = await prepareSubscriptionChangeConfirmation(
    db,
    args,
    signal,
  );
  if (!preparation.ready) {
    return preparation.result;
  }
  return await applyStoredSubscriptionChange(db, preparation.stored, signal);
}

function invoiceSubscriptionId(
  invoice: UsagePackSubscriptionChangeInvoiceInput,
): string | null {
  return stripeObjectId(invoice.parent?.subscription_details?.subscription);
}

async function findSubscriptionChangeForInvoice(
  db: Pick<Db, "select">,
  invoice: UsagePackSubscriptionChangeInvoiceInput,
): Promise<UsagePackSubscriptionChangeRow | null> {
  const [bound] = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(eq(usagePackSubscriptionChanges.stripeInvoiceId, invoice.id))
    .limit(1);
  if (bound) {
    return bound;
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return null;
  }
  const [subscription] = await db
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);
  if (!subscription) {
    return null;
  }
  const [candidate] = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(
      and(
        eq(
          usagePackSubscriptionChanges.usagePackSubscriptionId,
          subscription.id,
        ),
        inArray(usagePackSubscriptionChanges.status, [
          "applying",
          "pending_payment",
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptionChanges.createdAt))
    .limit(1);
  return candidate ?? null;
}

export async function handleUsagePackSubscriptionChangeInvoicePaid(
  db: Db,
  invoice: UsagePackSubscriptionChangeInvoiceInput,
): Promise<UsagePackSubscriptionChangeInvoiceOutcome> {
  if (!(await usagePackSubscriptionChangeSchemaAvailable(db))) {
    return { handled: false, orgId: null };
  }
  const root = await findSubscriptionChangeForInvoice(db, invoice);
  if (!root) {
    return { handled: false, orgId: null };
  }
  if (invoice.status !== "paid" && invoice.paid !== true) {
    throw new Error(
      `Usage pack subscription change invoice ${invoice.id} is not paid`,
    );
  }
  const stored = await loadStoredSubscriptionChange(db, root.id);
  if (!stored?.subscription.stripeSubscriptionId) {
    throw new Error(`Subscription change ${root.id} lost its subscription`);
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId !== stored.subscription.stripeSubscriptionId) {
    throw new Error(
      `Subscription change invoice ${invoice.id} has the wrong subscription`,
    );
  }
  if (
    stripeObjectId(invoice.customer) !== stored.subscription.stripeCustomerId
  ) {
    throw new Error(
      `Subscription change invoice ${invoice.id} has the wrong customer`,
    );
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] },
  );
  const expectedImmediateTier = planIsUpgrade(root.sourceTier, root.targetTier)
    ? root.targetTier
    : root.sourceTier;
  if (subscriptionPlanTier(subscription) !== expectedImmediateTier) {
    throw new Error(
      `Subscription change invoice ${invoice.id} was paid before the plan change was applied`,
    );
  }
  const period = usagePackPeriod(subscription);
  await reconcileUsagePackAllocationChangeSubscription(db, subscription);
  await fulfillUsagePackSubscriptionChangeInvoice(db, {
    subscriptionChangeId: root.id,
    prorationTimestamp: root.prorationTimestamp,
    periodStart: period.start,
    periodEnd: period.end,
    invoice,
  });
  const refreshed = await loadStoredSubscriptionChange(db, root.id);
  if (!refreshed) {
    throw new Error(`Subscription change ${root.id} disappeared`);
  }
  const hasDeferredChanges =
    planIsDowngrade(root.sourceTier, root.targetTier) ||
    refreshed.allocationChanges.some((change) => {
      return change.kind === "downgrade";
    });
  if (hasDeferredChanges) {
    await scheduleDeferredSubscriptionChange(
      db,
      refreshed,
      subscription,
      undefined,
    );
  } else {
    const completedAt = nowDate();
    await db
      .update(usagePackSubscriptionChanges)
      .set({ status: "completed", completedAt, updatedAt: completedAt })
      .where(eq(usagePackSubscriptionChanges.id, root.id));
  }
  return { handled: true, orgId: root.orgId, subscription };
}

async function failExpiredPendingSubscriptionChange(
  db: Db,
  root: UsagePackSubscriptionChangeRow,
): Promise<void> {
  const completedAt = nowDate();
  await db.transaction(async (tx) => {
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "failed",
        failureReason: "pending_update_expired",
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackSubscriptionChanges.id, root.id));
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "pending_update_expired",
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id));
  });
}

async function rollbackUnpaidSubscriptionChange(
  db: Db,
  stored: NonNullable<Awaited<ReturnType<typeof loadStoredSubscriptionChange>>>,
  subscription: StripeSubscription,
  invoice: StripeInvoice | null,
  signal: AbortSignal,
): Promise<void> {
  const stripe = getStripeClient();
  if (invoice?.status === "open") {
    await stripe.invoices.voidInvoice(
      invoice.id,
      {},
      {
        idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:void`,
      },
    );
    signal.throwIfAborted();
  }
  const items = subscriptionUpdateItems(
    subscription,
    subscriptionPlanItem(subscription),
    stored.subscription.stripePlanPriceId,
    packageQuantitiesFromAllocations(stored.allocations),
  );
  if (items.length > 0) {
    await stripe.subscriptions.update(
      subscription.id,
      {
        items,
        proration_behavior: "none",
      },
      {
        idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:rollback`,
      },
    );
    signal.throwIfAborted();
  }
  await failExpiredPendingSubscriptionChange(db, stored.root);
}

async function expireSubscriptionChangePreviews(
  db: Db,
  at: Date,
): Promise<number> {
  const expired = await db
    .update(usagePackSubscriptionChanges)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackSubscriptionChanges.status, "previewed"),
        lte(usagePackSubscriptionChanges.previewExpiresAt, at),
      ),
    )
    .returning({ id: usagePackSubscriptionChanges.id });
  if (expired.length > 0) {
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        inArray(
          usagePackAllocationChanges.subscriptionChangeId,
          expired.map((root) => {
            return root.id;
          }),
        ),
      );
  }
  return expired.length;
}

async function subscriptionChangeInvoice(
  root: UsagePackSubscriptionChangeRow,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<StripeInvoice | null> {
  const latestInvoice = expandedLatestInvoice(subscription);
  if (!root.stripeInvoiceId || latestInvoice?.id === root.stripeInvoiceId) {
    return latestInvoice;
  }
  const invoice = await getStripeClient().invoices.retrieve(
    root.stripeInvoiceId,
  );
  signal.throwIfAborted();
  return invoice;
}

function pendingSubscriptionPaymentExpired(
  root: UsagePackSubscriptionChangeRow,
  at: Date,
  paymentExpiredBefore: Date,
): boolean {
  return (
    root.status === "pending_payment" &&
    ((root.stripePendingUpdateExpiresAt !== null &&
      root.stripePendingUpdateExpiresAt <= at) ||
      (root.stripePendingUpdateExpiresAt === null &&
        root.updatedAt <= paymentExpiredBefore))
  );
}

function immediateSubscriptionProjectionMatches(
  stored: StoredSubscriptionChange,
  subscription: StripeSubscription,
): boolean {
  const expectedImmediateTier = planIsUpgrade(
    stored.root.sourceTier,
    stored.root.targetTier,
  )
    ? stored.root.targetTier
    : stored.root.sourceTier;
  const expectedPackageQuantities = projectedPackageQuantities(
    stored.allocations,
    stored.allocationChanges,
    (change) => {
      return change.kind === "addition" || change.kind === "upgrade";
    },
  );
  return (
    subscriptionPlanTier(subscription) === expectedImmediateTier &&
    quantitiesMatch(
      expectedPackageQuantities,
      packageQuantitiesFromSubscription(subscription),
    )
  );
}

async function reconcileSubscriptionChangeCandidate(
  db: Db,
  args: {
    readonly root: UsagePackSubscriptionChangeRow;
    readonly at: Date;
    readonly paymentExpiredBefore: Date;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const stored = await loadStoredSubscriptionChange(db, args.root.id);
  const subscriptionId = stored?.subscription.stripeSubscriptionId;
  if (!stored || !subscriptionId) {
    return null;
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  if (subscription.pending_update) {
    return null;
  }
  const invoice = await subscriptionChangeInvoice(
    args.root,
    subscription,
    signal,
  );
  if (invoice?.status === "paid") {
    const outcome = await handleUsagePackSubscriptionChangeInvoicePaid(
      db,
      invoice,
    );
    return outcome.handled ? outcome.orgId : null;
  }
  if (
    pendingSubscriptionPaymentExpired(
      args.root,
      args.at,
      args.paymentExpiredBefore,
    )
  ) {
    await rollbackUnpaidSubscriptionChange(
      db,
      stored,
      subscription,
      invoice,
      signal,
    );
    return args.root.orgId;
  }
  if (!immediateSubscriptionProjectionMatches(stored, subscription)) {
    await failExpiredPendingSubscriptionChange(db, args.root);
    return args.root.orgId;
  }
  return null;
}

export async function reconcileUsagePackSubscriptionChanges(
  db: Db,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}> {
  if (!(await usagePackSubscriptionChangeSchemaAvailable(db))) {
    return { reconciled: 0, orgIds: [] };
  }
  signal.throwIfAborted();
  const at = nowDate();
  const staleBefore = new Date(at.getTime() - RECONCILIATION_DELAY_MS);
  const paymentExpiredBefore = new Date(
    at.getTime() - PAYMENT_CONFIRMATION_TTL_MS,
  );
  const expiredCount = await expireSubscriptionChangePreviews(db, at);
  const candidates = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(
      and(
        inArray(usagePackSubscriptionChanges.status, [
          "applying",
          "pending_payment",
        ]),
        lte(usagePackSubscriptionChanges.updatedAt, staleBefore),
      ),
    )
    .limit(100);
  const orgIds = new Set<string>();
  let reconciled = expiredCount;
  for (const root of candidates) {
    const reconciledOrgId = await reconcileSubscriptionChangeCandidate(
      db,
      {
        root,
        at,
        paymentExpiredBefore,
      },
      signal,
    );
    if (reconciledOrgId) {
      reconciled += 1;
      orgIds.add(reconciledOrgId);
    }
  }
  return { reconciled, orgIds: [...orgIds] };
}
