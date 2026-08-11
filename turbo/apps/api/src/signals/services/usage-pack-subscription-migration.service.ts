import type {
  MemberUsagePack,
  UsagePackMigrationConfirmResponse,
  UsagePackMigrationPreviewResponse,
  UsagePackMigrationStateResponse,
  UsagePackUsd,
} from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  usagePackAllocations,
  usagePackInvitationPurchases,
  usagePackSubscriptionMigrations,
  usagePackSubscriptionMigrationSelections,
  usagePackSubscriptions,
} from "@vm0/db/schema/usage-pack-subscription";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { lockUsagePackBillingOrg } from "./usage-pack-allocation-change.service";
import {
  handleUsagePackInvoicePaid,
  handleUsagePackSubscriptionUpdated,
  loadUsagePackCatalog,
  usagePackSubscriptionIdFromMetadata,
  usagePackSubscriptionMetadata,
  type UsagePackInvoiceInput,
  type UsagePackSubscriptionInput,
} from "./usage-pack-subscription.service";
import {
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  tierForKnownPriceId,
  usagePackUsdForKnownPriceId,
  type SubscriptionCheckoutTier,
} from "./zero-billing-checkout.service";

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const OPEN_MIGRATION_STATUSES = ["previewed", "applying", "scheduled"] as const;
const RECONCILING_MIGRATION_STATUSES = ["applying", "scheduled"] as const;
const L = logger("UsagePackSubscriptionMigration");

type MigrationRow = typeof usagePackSubscriptionMigrations.$inferSelect;
type MigrationSelectionRow =
  typeof usagePackSubscriptionMigrationSelections.$inferSelect;

export type UsagePackMigrationOwner =
  | { readonly userId: string }
  | {
      readonly invitationId: string;
      readonly normalizedEmail: string;
      readonly role: "admin" | "member";
      readonly inviterUserId: string;
    };

interface LegacyMigrationContext {
  readonly org: {
    readonly orgId: string;
    readonly tier: SubscriptionCheckoutTier;
    readonly stripeCustomerId: string;
    readonly stripeSubscriptionId: string;
  };
  readonly subscription: StripeSubscription;
  readonly legacyItem: StripeSubscriptionItem;
}

interface PreparedMigrationSelection {
  readonly userId: string | null;
  readonly invitationId: string | null;
  readonly normalizedEmail: string | null;
  readonly role: "admin" | "member" | null;
  readonly inviterUserId: string | null;
  readonly usagePackUsd: UsagePackUsd;
  readonly stripePriceId: string;
  readonly unitAmountCents: number;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
}

type AppliedMigrationResult =
  | {
      readonly status: "active";
      readonly response: UsagePackMigrationConfirmResponse;
      readonly orgId: string;
    }
  | { readonly status: "failed"; readonly orgId: string };

type MigrationStateResult =
  | {
      readonly status: "ready";
      readonly state: UsagePackMigrationStateResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "conflict" };

type MigrationPreviewResult =
  | {
      readonly status: "ready";
      readonly preview: UsagePackMigrationPreviewResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" };

type MigrationConfirmResult =
  | {
      readonly status: "confirmed";
      readonly response: UsagePackMigrationConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" };

interface UsagePackMigrationLifecycleOutcome {
  readonly handled: boolean;
  readonly orgId: string | null;
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function safeInvoiceAmount(invoice: StripeInvoice, label: string): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error(`Stripe ${label} migration preview has an invalid amount`);
  }
  return invoice.amount_due;
}

function migrationOwnerId(owner: UsagePackMigrationOwner): string {
  return "userId" in owner ? owner.userId : owner.invitationId;
}

function selectionOwnerId(selection: MigrationSelectionRow): string {
  const ownerId = selection.userId ?? selection.invitationId;
  if (!ownerId) {
    throw new Error(
      `Usage pack migration selection ${selection.id} has no owner`,
    );
  }
  return ownerId;
}

function exactOwnerIds(
  selections: readonly { readonly memberId: string }[],
  owners: readonly UsagePackMigrationOwner[],
): boolean {
  const selectionIds = new Set(
    selections.map((selection) => {
      return selection.memberId;
    }),
  );
  const ownerIds = new Set(owners.map(migrationOwnerId));
  return (
    selectionIds.size === selections.length &&
    ownerIds.size === owners.length &&
    selectionIds.size === ownerIds.size &&
    [...ownerIds].every((ownerId) => {
      return selectionIds.has(ownerId);
    })
  );
}

function exactStoredOwnerIds(
  selections: readonly MigrationSelectionRow[],
  ownerIds: readonly string[],
): boolean {
  const stored = new Set(selections.map(selectionOwnerId));
  const current = new Set(ownerIds);
  return (
    stored.size === selections.length &&
    current.size === ownerIds.length &&
    stored.size === current.size &&
    [...stored].every((ownerId) => {
      return current.has(ownerId);
    })
  );
}

export async function usagePackSubscriptionMigrationSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('public.usage_pack_subscription_migrations') IS NOT NULL AND to_regclass('public.usage_pack_subscription_migration_selections') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

async function loadOpenMigrationForOrg(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<MigrationRow | null> {
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      and(
        eq(usagePackSubscriptionMigrations.orgId, orgId),
        inArray(usagePackSubscriptionMigrations.status, [
          ...OPEN_MIGRATION_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptionMigrations.createdAt))
    .limit(1);
  return migration ?? null;
}

async function loadMigrationSelections(
  db: Pick<Db, "select">,
  migrationId: string,
): Promise<readonly MigrationSelectionRow[]> {
  return await db
    .select()
    .from(usagePackSubscriptionMigrationSelections)
    .where(
      eq(usagePackSubscriptionMigrationSelections.migrationId, migrationId),
    );
}

function legacyPlanItem(
  subscription: StripeSubscription,
  tier: SubscriptionCheckoutTier,
): StripeSubscriptionItem | null {
  const planItems = subscription.items.data.filter((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
  if (planItems.length !== 1) {
    return null;
  }
  const item = planItems[0];
  return item &&
    tierForKnownPriceId(item.price.id) === tier &&
    !isUsagePackPlanPriceId(item.price.id) &&
    (item.quantity ?? 1) === 1
    ? item
    : null;
}

function subscriptionHasUsagePackItems(
  subscription: StripeSubscription,
): boolean {
  return subscription.items.data.some((item) => {
    return (
      isUsagePackPlanPriceId(item.price.id) ||
      usagePackUsdForKnownPriceId(item.price.id) !== null
    );
  });
}

function eligibleLegacySubscription(subscription: StripeSubscription): boolean {
  return (
    subscription.status === "active" &&
    subscription.cancel_at === null &&
    !subscription.cancel_at_period_end &&
    stripeObjectId(subscription.schedule) === null
  );
}

async function loadLegacyMigrationContext(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<LegacyMigrationContext | null> {
  const [row] = await db
    .select({
      orgId: orgMetadata.orgId,
      tier: orgMetadata.tier,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      pendingSubscriptionScheduleId: orgMetadata.pendingSubscriptionScheduleId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (
    !row ||
    (row.tier !== "pro" && row.tier !== "team") ||
    !row.stripeCustomerId ||
    !row.stripeSubscriptionId ||
    row.subscriptionStatus !== "active" ||
    row.cancelAtPeriodEnd ||
    row.pendingSubscriptionScheduleId
  ) {
    return null;
  }

  const subscription = await getStripeClient().subscriptions.retrieve(
    row.stripeSubscriptionId,
  );
  const legacyItem = legacyPlanItem(subscription, row.tier);
  if (
    !eligibleLegacySubscription(subscription) ||
    stripeObjectId(subscription.customer) !== row.stripeCustomerId ||
    !legacyItem ||
    subscriptionHasUsagePackItems(subscription)
  ) {
    return null;
  }
  return {
    org: {
      orgId: row.orgId,
      tier: row.tier,
      stripeCustomerId: row.stripeCustomerId,
      stripeSubscriptionId: row.stripeSubscriptionId,
    },
    subscription,
    legacyItem,
  };
}

function migrationState(
  migration: MigrationRow,
): UsagePackMigrationStateResponse {
  if (migration.status === "completed" || migration.status === "failed") {
    throw new Error(`Migration ${migration.id} is not open`);
  }
  return {
    tier: migration.sourceTier,
    targetTier: migration.targetTier,
    status: migration.status,
    migrationId: migration.id,
    effectiveAt: migration.effectiveAt.toISOString(),
    hostedInvoiceUrl: migration.hostedInvoiceUrl,
  };
}

export async function getUsagePackMigrationState(
  db: Db,
  orgId: string,
): Promise<MigrationStateResult> {
  const at = nowDate();
  const open = await loadOpenMigrationForOrg(db, orgId);
  if (open?.status === "previewed" && open.previewExpiresAt <= at) {
    await db
      .update(usagePackSubscriptionMigrations)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, open.id),
          eq(usagePackSubscriptionMigrations.status, "previewed"),
        ),
      );
  } else if (open) {
    return { status: "ready", state: migrationState(open) };
  }

  const context = await loadLegacyMigrationContext(db, orgId);
  if (!context) {
    return { status: "not_found" };
  }
  if (context.subscription.pending_update) {
    return { status: "conflict" };
  }
  return {
    status: "ready",
    state: {
      tier: context.org.tier,
      targetTier: null,
      status: "eligible",
      migrationId: null,
      effectiveAt: new Date(
        migrationPeriod(context.legacyItem).end * 1000,
      ).toISOString(),
      hostedInvoiceUrl: null,
    },
  };
}

function migrationPeriod(item: StripeSubscriptionItem): {
  readonly start: number;
  readonly end: number;
} {
  const start = item.current_period_start;
  const end = item.current_period_end;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start
  ) {
    throw new Error("Legacy subscription has an invalid billing period");
  }
  return { start, end };
}

function migrationUpdateItems(
  legacyItemId: string,
  stripePlanPriceId: string,
  selections: readonly {
    readonly stripePriceId: string;
  }[],
): StripeSubscriptionUpdateItemParam[] {
  const quantities = new Map<string, number>();
  for (const selection of selections) {
    quantities.set(
      selection.stripePriceId,
      (quantities.get(selection.stripePriceId) ?? 0) + 1,
    );
  }
  return [
    { id: legacyItemId, deleted: true },
    { price: stripePlanPriceId, quantity: 1 },
    ...[...quantities].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

async function prepareMigrationSelections(
  requested: readonly MemberUsagePack[],
  owners: readonly UsagePackMigrationOwner[],
): Promise<readonly PreparedMigrationSelection[] | null> {
  if (!exactOwnerIds(requested, owners)) {
    return null;
  }
  const catalog = await loadUsagePackCatalog();
  const ownersById = new Map(
    owners.map((owner) => {
      return [migrationOwnerId(owner), owner] as const;
    }),
  );
  return requested.map((requestedSelection) => {
    const owner = ownersById.get(requestedSelection.memberId);
    const catalogItem = catalog.find((item) => {
      return item.usagePackUsd === requestedSelection.usagePackUsd;
    });
    const stripePriceId = activeUsagePackPriceId(
      requestedSelection.usagePackUsd,
    );
    const unitAmountCents = catalogItem
      ? Math.round(catalogItem.priceUsd * 100)
      : 0;
    if (
      !owner ||
      !catalogItem ||
      !stripePriceId ||
      !Number.isSafeInteger(unitAmountCents) ||
      unitAmountCents <= 0
    ) {
      throw new Error(
        `Usage pack $${requestedSelection.usagePackUsd} is not configured`,
      );
    }
    return {
      userId: "userId" in owner ? owner.userId : null,
      invitationId: "invitationId" in owner ? owner.invitationId : null,
      normalizedEmail: "invitationId" in owner ? owner.normalizedEmail : null,
      role: "invitationId" in owner ? owner.role : null,
      inviterUserId: "invitationId" in owner ? owner.inviterUserId : null,
      usagePackUsd: requestedSelection.usagePackUsd,
      stripePriceId,
      unitAmountCents,
      purchasedCredits: catalogItem.purchasedCredits,
      bonusCredits: catalogItem.bonusCredits,
    };
  });
}

async function persistMigrationPreview(
  db: Db,
  context: LegacyMigrationContext,
  selections: readonly PreparedMigrationSelection[],
  args: {
    readonly targetTier: SubscriptionCheckoutTier;
    readonly stripePlanPriceId: string;
    readonly currentRecurringAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly recurringDifferenceCents: number;
    readonly currency: string;
    readonly effectiveAt: Date;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<MigrationRow | null> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, context.org.orgId);
    const [inProgress] = await tx
      .select({ id: usagePackSubscriptionMigrations.id })
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.orgId, context.org.orgId),
          inArray(usagePackSubscriptionMigrations.status, [
            "applying",
            "scheduled",
          ]),
        ),
      )
      .limit(1);
    if (inProgress) {
      return null;
    }
    await tx
      .update(usagePackSubscriptionMigrations)
      .set({
        status: "failed",
        failureReason: "preview_superseded",
        completedAt: args.createdAt,
        updatedAt: args.createdAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionMigrations.orgId, context.org.orgId),
          eq(usagePackSubscriptionMigrations.status, "previewed"),
        ),
      );
    const [migration] = await tx
      .insert(usagePackSubscriptionMigrations)
      .values({
        orgId: context.org.orgId,
        sourceTier: context.org.tier,
        targetTier: args.targetTier,
        stripeCustomerId: context.org.stripeCustomerId,
        stripeSubscriptionId: context.org.stripeSubscriptionId,
        legacyStripePriceId: context.legacyItem.price.id,
        legacyStripeItemId: context.legacyItem.id,
        stripePlanPriceId: args.stripePlanPriceId,
        currentRecurringAmountCents: args.currentRecurringAmountCents,
        nextRecurringAmountCents: args.nextRecurringAmountCents,
        recurringDifferenceCents: args.recurringDifferenceCents,
        currency: args.currency,
        effectiveAt: args.effectiveAt,
        previewExpiresAt: args.expiresAt,
        createdAt: args.createdAt,
        updatedAt: args.createdAt,
      })
      .returning();
    if (!migration) {
      throw new Error("Failed to create usage pack migration preview");
    }
    await tx.insert(usagePackSubscriptionMigrationSelections).values(
      selections.map((selection) => {
        return { migrationId: migration.id, ...selection };
      }),
    );
    return migration;
  });
}

export async function previewUsagePackSubscriptionMigration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly targetTier: SubscriptionCheckoutTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly owners: readonly UsagePackMigrationOwner[];
  },
  signal: AbortSignal,
): Promise<MigrationPreviewResult> {
  const context = await loadLegacyMigrationContext(db, args.orgId);
  signal.throwIfAborted();
  if (!context) {
    return { status: "not_found" };
  }
  if (context.subscription.pending_update) {
    return { status: "conflict" };
  }
  const selections = await prepareMigrationSelections(
    args.memberUsagePacks,
    args.owners,
  );
  signal.throwIfAborted();
  if (!selections) {
    return { status: "owners_changed" };
  }

  const period = migrationPeriod(context.legacyItem);
  const stripePlanPriceId = activeUsagePackPlanPriceId(args.targetTier);
  if (!stripePlanPriceId) {
    throw new Error(
      `${args.targetTier} usage pack plan Price is not configured`,
    );
  }
  const targetItems = migrationUpdateItems(
    context.legacyItem.id,
    stripePlanPriceId,
    selections,
  );
  const currentItems = context.subscription.items.data.map((item) => {
    return {
      id: item.id,
      price: item.price.id,
      quantity: item.quantity ?? 1,
    };
  });
  const stripe = getStripeClient();
  const [currentPreview, targetPreview] = await Promise.all([
    stripe.invoices.createPreview({
      subscription: context.subscription.id,
      preview_mode: "recurring",
      subscription_details: {
        items: currentItems,
      },
    }),
    stripe.invoices.createPreview({
      subscription: context.subscription.id,
      preview_mode: "recurring",
      subscription_details: {
        items: targetItems,
      },
    }),
  ]);
  signal.throwIfAborted();
  if (currentPreview.currency !== targetPreview.currency) {
    throw new Error("Stripe migration previews returned different currencies");
  }
  const currentRecurringAmountCents = safeInvoiceAmount(
    currentPreview,
    "current recurring",
  );
  const nextRecurringAmountCents = safeInvoiceAmount(
    targetPreview,
    "target recurring",
  );
  const recurringDifferenceCents =
    nextRecurringAmountCents - currentRecurringAmountCents;
  const createdAt = nowDate();
  const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS);
  const effectiveAt = new Date(period.end * 1000);
  const migration = await persistMigrationPreview(db, context, selections, {
    targetTier: args.targetTier,
    stripePlanPriceId,
    currentRecurringAmountCents,
    nextRecurringAmountCents,
    recurringDifferenceCents,
    currency: targetPreview.currency,
    effectiveAt,
    createdAt,
    expiresAt,
  });
  if (!migration) {
    return { status: "conflict" };
  }
  const purchasedCredits = selections.reduce((total, selection) => {
    return total + selection.purchasedCredits;
  }, 0);
  const bonusCredits = selections.reduce((total, selection) => {
    return total + selection.bonusCredits;
  }, 0);
  return {
    status: "ready",
    preview: {
      migrationId: migration.id,
      tier: migration.sourceTier,
      targetTier: migration.targetTier,
      currentRecurringAmountCents,
      nextRecurringAmountCents,
      recurringDifferenceCents,
      currency: migration.currency,
      purchasedCredits,
      bonusCredits,
      totalCredits: purchasedCredits + bonusCredits,
      effectiveAt: migration.effectiveAt.toISOString(),
      expiresAt: migration.previewExpiresAt.toISOString(),
    },
  };
}

function packageQuantities(
  selections: readonly { readonly stripePriceId: string }[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const selection of selections) {
    quantities.set(
      selection.stripePriceId,
      (quantities.get(selection.stripePriceId) ?? 0) + 1,
    );
  }
  return quantities;
}

function desiredMigrationShape(
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
): boolean {
  const effectiveAt = Math.floor(migration.effectiveAt.getTime() / 1000);
  if (
    stripeObjectId(subscription.customer) !== migration.stripeCustomerId ||
    subscription.items.data.some((item) => {
      return item.id === migration.legacyStripeItemId;
    })
  ) {
    return false;
  }
  const planItems = subscription.items.data.filter((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
  if (
    planItems.length !== 1 ||
    planItems[0]?.price.id !== migration.stripePlanPriceId ||
    (planItems[0].quantity ?? 1) !== 1 ||
    planItems[0].current_period_start !== effectiveAt
  ) {
    return false;
  }
  const expected = packageQuantities(selections);
  const actual = new Map<string, number>();
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    if (item.current_period_start !== effectiveAt) {
      return false;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return false;
    }
    actual.set(item.price.id, (actual.get(item.price.id) ?? 0) + quantity);
  }
  return (
    expected.size === actual.size &&
    [...expected].every(([priceId, quantity]) => {
      return actual.get(priceId) === quantity;
    })
  );
}

function legacyMigrationShape(
  migration: MigrationRow,
  subscription: StripeSubscription,
): boolean {
  const legacyItem = legacyPlanItem(subscription, migration.sourceTier);
  if (!legacyItem) {
    return false;
  }
  const period = migrationPeriod(legacyItem);
  const scheduleId = stripeObjectId(subscription.schedule);
  return (
    subscription.status === "active" &&
    subscription.cancel_at === null &&
    !subscription.cancel_at_period_end &&
    stripeObjectId(subscription.customer) === migration.stripeCustomerId &&
    legacyItem.id === migration.legacyStripeItemId &&
    legacyItem.price.id === migration.legacyStripePriceId &&
    migration.effectiveAt.getTime() === period.end * 1000 &&
    (!migration.stripeScheduleId ||
      scheduleId === migration.stripeScheduleId) &&
    !subscriptionHasUsagePackItems(subscription)
  );
}

interface PaidInvoicePaymentIntent {
  readonly id: string;
  readonly amountPaidCents: number;
}

function paidInvoicePaymentIntent(
  invoice: StripeInvoice,
): PaidInvoicePaymentIntent | null {
  const payment = invoice.payments?.data.find((candidate) => {
    return (
      candidate.status === "paid" && candidate.payment.type === "payment_intent"
    );
  });
  if (!payment) {
    return null;
  }
  const id = stripeObjectId(payment.payment.payment_intent ?? null);
  if (
    !id ||
    !Number.isSafeInteger(payment.amount_paid) ||
    (payment.amount_paid ?? -1) < 0
  ) {
    throw new Error(`Migration invoice ${invoice.id} has an invalid payment`);
  }
  return { id, amountPaidCents: payment.amount_paid ?? 0 };
}

function invoicePaymentIntentId(invoice: StripeInvoice): string | null {
  return paidInvoicePaymentIntent(invoice)?.id ?? null;
}

async function retrieveMigrationInvoice(
  invoiceId: string,
): Promise<StripeInvoice> {
  return await getStripeClient().invoices.retrieve(invoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });
}

function latestInvoiceId(subscription: StripeSubscription): string | null {
  return stripeObjectId(subscription.latest_invoice);
}

async function persistMigrationInvoiceState(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
): Promise<MigrationRow> {
  const candidateInvoiceIds = new Set(
    [latestInvoiceId(subscription), migration.stripeInvoiceId].filter(
      (invoiceId): invoiceId is string => {
        return invoiceId !== null;
      },
    ),
  );
  let invoice: StripeInvoice | null = null;
  for (const invoiceId of candidateInvoiceIds) {
    const candidate = await retrieveMigrationInvoice(invoiceId);
    if (migrationInvoiceMatchesSelections(candidate, migration, selections)) {
      invoice = candidate;
      break;
    }
  }
  const updatedAt = nowDate();
  const [updated] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "scheduled",
      stripeInvoiceId: invoice?.id ?? migration.stripeInvoiceId,
      stripePaymentIntentId:
        (invoice ? invoicePaymentIntentId(invoice) : null) ??
        migration.stripePaymentIntentId,
      hostedInvoiceUrl:
        invoice?.hosted_invoice_url ?? migration.hostedInvoiceUrl,
      updatedAt,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        inArray(usagePackSubscriptionMigrations.status, [
          ...RECONCILING_MIGRATION_STATUSES,
        ]),
      ),
    )
    .returning();
  return updated ?? migration;
}

async function materializeUsagePackSnapshot(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, migration.orgId);
    const [locked] = await tx
      .select()
      .from(usagePackSubscriptionMigrations)
      .where(eq(usagePackSubscriptionMigrations.id, migration.id))
      .for("update")
      .limit(1);
    if (!locked || locked.status === "failed") {
      throw new Error(`Usage pack migration ${migration.id} is not active`);
    }
    const [existing] = await tx
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, migration.id))
      .limit(1);
    if (!existing) {
      await tx.insert(usagePackSubscriptions).values({
        id: migration.id,
        orgId: migration.orgId,
        tier: migration.targetTier,
        stripePlanPriceId: migration.stripePlanPriceId,
        stripeCustomerId: migration.stripeCustomerId,
        stripeSubscriptionId: migration.stripeSubscriptionId,
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      });
      await tx.insert(usagePackAllocations).values(
        selections.map((selection) => {
          return {
            usagePackSubscriptionId: migration.id,
            orgId: migration.orgId,
            userId: selection.userId,
            invitationId: selection.invitationId,
            usagePackUsd: selection.usagePackUsd,
            stripePriceId: selection.stripePriceId,
            status: "pending_payment" as const,
          };
        }),
      );
      return;
    }
    if (
      existing.orgId !== migration.orgId ||
      existing.stripeCustomerId !== migration.stripeCustomerId ||
      existing.stripeSubscriptionId !== migration.stripeSubscriptionId ||
      existing.stripePlanPriceId !== migration.stripePlanPriceId
    ) {
      throw new Error(`Usage pack migration ${migration.id} snapshot changed`);
    }
    const allocations = await tx
      .select({ id: usagePackAllocations.id })
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.usagePackSubscriptionId, migration.id));
    if (allocations.length !== selections.length) {
      throw new Error(
        `Usage pack migration ${migration.id} allocations changed`,
      );
    }
  });
}

function invoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string" ? price : (price?.id ?? null);
}

function invoiceLineAmount(line: StripeInvoiceLine): number | null {
  const amount = line.subtotal ?? line.amount;
  return Number.isSafeInteger(amount) ? amount : null;
}

function invoiceLineIsProration(line: StripeInvoiceLine): boolean {
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

function migrationInvoiceLineMatchesPeriod(
  line: StripeInvoiceLine,
  migration: MigrationRow,
): boolean {
  const effectiveAt = Math.floor(migration.effectiveAt.getTime() / 1000);
  return (
    !invoiceLineIsProration(line) &&
    line.period.start === effectiveAt &&
    line.period.end > effectiveAt
  );
}

function migrationInvoiceMatchesSelections(
  invoice: StripeInvoice,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): boolean {
  if (
    stripeObjectId(invoice.customer) !== migration.stripeCustomerId ||
    stripeObjectId(invoice.parent?.subscription_details?.subscription) !==
      migration.stripeSubscriptionId ||
    invoice.currency !== migration.currency
  ) {
    return false;
  }
  const expected = packageQuantities(selections);
  const actual = new Map<string, number>();
  let targetPlanQuantity = 0;
  for (const line of invoice.lines.data) {
    const priceId = invoiceLinePriceId(line);
    if (!priceId) {
      continue;
    }
    const quantity = line.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return false;
    }
    if (priceId === migration.stripePlanPriceId) {
      if (!migrationInvoiceLineMatchesPeriod(line, migration)) {
        return false;
      }
      targetPlanQuantity += quantity;
      continue;
    }
    if (usagePackUsdForKnownPriceId(priceId) === null) {
      continue;
    }
    if (!migrationInvoiceLineMatchesPeriod(line, migration)) {
      return false;
    }
    actual.set(priceId, (actual.get(priceId) ?? 0) + quantity);
  }
  return (
    targetPlanQuantity === 1 &&
    expected.size === actual.size &&
    [...expected].every(([priceId, quantity]) => {
      return actual.get(priceId) === quantity;
    })
  );
}

interface SelectionCredits {
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly weight: number;
}

function selectionCreditsForInvoice(
  invoice: StripeInvoice,
  selections: readonly MigrationSelectionRow[],
): ReadonlyMap<string, SelectionCredits> {
  const quantities = packageQuantities(selections);
  const credits = new Map<string, SelectionCredits>();
  for (const [priceId, quantity] of quantities) {
    const matching = invoice.lines.data.filter((line) => {
      const amount = invoiceLineAmount(line);
      return (
        invoiceLinePriceId(line) === priceId && amount !== null && amount > 0
      );
    });
    if (matching.length !== 1) {
      throw new Error(
        `Migration invoice ${invoice.id} must have one positive line for ${priceId}`,
      );
    }
    const line = matching[0];
    const amount = line ? invoiceLineAmount(line) : null;
    if (!line || amount === null) {
      throw new Error(`Migration invoice ${invoice.id} has an invalid line`);
    }
    const lineQuantity = line.quantity ?? 1;
    if (lineQuantity !== quantity) {
      throw new Error(
        `Migration invoice ${invoice.id} quantity for ${priceId} changed`,
      );
    }
    const selected = selections.filter((selection) => {
      return selection.stripePriceId === priceId;
    });
    for (const selection of selected) {
      const fullAmount = selection.unitAmountCents * quantity;
      if (amount > fullAmount) {
        throw new Error(
          `Migration invoice ${invoice.id} amount for ${priceId} is invalid`,
        );
      }
      const fraction = amount / fullAmount;
      credits.set(selection.id, {
        purchasedCredits: Math.floor(selection.purchasedCredits * fraction),
        bonusCredits: Math.floor(selection.bonusCredits * fraction),
        weight: amount / quantity,
      });
    }
  }
  return credits;
}

function paidAmountsBySelection(
  invoiceAmountDueCents: number,
  amountPaidCents: number,
  selections: readonly MigrationSelectionRow[],
  credits: ReadonlyMap<string, SelectionCredits>,
): ReadonlyMap<string, number> {
  if (
    !Number.isSafeInteger(invoiceAmountDueCents) ||
    invoiceAmountDueCents < 0 ||
    !Number.isSafeInteger(amountPaidCents) ||
    amountPaidCents < 0
  ) {
    throw new Error("Migration invoice has an invalid paid amount");
  }
  const totalWeight = selections.reduce((total, selection) => {
    return total + (credits.get(selection.id)?.weight ?? 0);
  }, 0);
  if (!(totalWeight > 0)) {
    throw new Error("Migration invoice has no package payment weight");
  }
  const refundableAmount =
    invoiceAmountDueCents === 0
      ? 0
      : Math.floor(
          (Math.min(amountPaidCents, invoiceAmountDueCents) *
            Math.min(totalWeight, invoiceAmountDueCents)) /
            invoiceAmountDueCents,
        );
  const ordered = [...selections].sort((left, right) => {
    return left.id.localeCompare(right.id);
  });
  const result = new Map<string, number>();
  let allocated = 0;
  for (const selection of ordered) {
    const weight = credits.get(selection.id)?.weight ?? 0;
    const amount = Math.floor((refundableAmount * weight) / totalWeight);
    result.set(selection.id, amount);
    allocated += amount;
  }
  let remainder = refundableAmount - allocated;
  for (const selection of ordered) {
    if (remainder === 0) {
      break;
    }
    result.set(selection.id, (result.get(selection.id) ?? 0) + 1);
    remainder -= 1;
  }
  return result;
}

function invoicePaidAt(invoice: StripeInvoice): Date {
  const paidAt = invoice.status_transitions?.paid_at;
  return typeof paidAt === "number" ? new Date(paidAt * 1000) : nowDate();
}

async function completeMigrationInvitations(
  db: Db,
  migration: MigrationRow,
  invoice: StripeInvoice,
): Promise<void> {
  const selections = await loadMigrationSelections(db, migration.id);
  const credits = selectionCreditsForInvoice(invoice, selections);
  const payment = paidInvoicePaymentIntent(invoice);
  const paymentIntentId = payment?.id ?? migration.stripePaymentIntentId;
  const paidAmounts = paidAmountsBySelection(
    safeInvoiceAmount(invoice, "paid"),
    payment?.amountPaidCents ?? 0,
    selections,
    credits,
  );
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, migration.orgId);
    const [locked] = await tx
      .select()
      .from(usagePackSubscriptionMigrations)
      .where(eq(usagePackSubscriptionMigrations.id, migration.id))
      .for("update")
      .limit(1);
    if (!locked || locked.status === "failed") {
      throw new Error(`Usage pack migration ${migration.id} cannot complete`);
    }
    if (locked.status === "completed") {
      return;
    }
    const allocations = await tx
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.usagePackSubscriptionId, migration.id));
    if (allocations.length !== selections.length) {
      throw new Error(
        `Usage pack migration ${migration.id} allocations changed`,
      );
    }
    for (const selection of selections) {
      if (!selection.invitationId) {
        continue;
      }
      const allocation = allocations.find((candidate) => {
        return candidate.invitationId === selection.invitationId;
      });
      const selectionCredit = credits.get(selection.id);
      if (
        !allocation ||
        !allocation.currentPeriodStart ||
        !allocation.currentPeriodEnd ||
        !selectionCredit ||
        !selection.normalizedEmail ||
        !selection.role ||
        !selection.inviterUserId
      ) {
        throw new Error(
          `Usage pack migration invitation ${selection.invitationId} is incomplete`,
        );
      }
      const amountPaidCents = paidAmounts.get(selection.id) ?? 0;
      await tx.insert(usagePackInvitationPurchases).values({
        usagePackSubscriptionId: migration.id,
        allocationId: allocation.id,
        orgId: migration.orgId,
        normalizedEmail: selection.normalizedEmail,
        role: selection.role,
        inviterUserId: selection.inviterUserId,
        usagePackUsd: selection.usagePackUsd,
        stripePriceId: selection.stripePriceId,
        status: "invitation_pending",
        currentPeriodStart: allocation.currentPeriodStart,
        currentPeriodEnd: allocation.currentPeriodEnd,
        prorationTimestamp: Math.floor(migration.effectiveAt.getTime() / 1000),
        unitAmountCents: selection.unitAmountCents,
        expectedAmountCents: amountPaidCents,
        amountPaidCents,
        currency: migration.currency,
        purchasedCredits: selectionCredit.purchasedCredits,
        bonusCredits: selectionCredit.bonusCredits,
        stripePaymentIntentId: amountPaidCents > 0 ? paymentIntentId : null,
        clerkInvitationId: selection.invitationId,
        paidAt: invoicePaidAt(invoice),
      });
    }
    const completedAt = nowDate();
    await tx
      .update(usagePackSubscriptionMigrations)
      .set({
        status: "completed",
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: paymentIntentId,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackSubscriptionMigrations.id, migration.id));
  });
}

function correlatedMigrationInvoice(
  invoice: StripeInvoice,
  migration: MigrationRow,
): UsagePackInvoiceInput {
  const subscriptionDetails = invoice.parent?.subscription_details;
  if (!subscriptionDetails) {
    throw new Error(`Migration invoice ${invoice.id} has no subscription`);
  }
  const metadata = usagePackSubscriptionMetadata({
    orgId: migration.orgId,
    tier: migration.targetTier,
    planPriceId: migration.stripePlanPriceId,
    usagePackSubscriptionId: migration.id,
  });
  return {
    ...invoice,
    metadata: { ...invoice.metadata, ...metadata },
    parent: {
      subscription_details: {
        ...subscriptionDetails,
        metadata: {
          ...subscriptionDetails.metadata,
          ...metadata,
        },
      },
    },
  } as UsagePackInvoiceInput;
}

async function finalizeAppliedMigration(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
  invoice: StripeInvoice,
): Promise<AppliedMigrationResult> {
  if (invoice.status !== "paid") {
    return {
      status: "active",
      orgId: migration.orgId,
      response: {
        status: "scheduled",
        effectiveAt: migration.effectiveAt.toISOString(),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      },
    };
  }
  await materializeUsagePackSnapshot(db, migration, selections, subscription);
  const metadata = usagePackSubscriptionMetadata({
    orgId: migration.orgId,
    tier: migration.targetTier,
    planPriceId: migration.stripePlanPriceId,
    usagePackSubscriptionId: migration.id,
  });
  const tagged = await getStripeClient().subscriptions.update(
    migration.stripeSubscriptionId,
    { metadata },
    { idempotencyKey: `usage-pack-migration:${migration.id}:metadata` },
  );
  const subscriptionOutcome = await handleUsagePackSubscriptionUpdated(
    db,
    tagged as UsagePackSubscriptionInput,
  );
  if (!subscriptionOutcome.handled) {
    throw new Error(`Usage pack migration ${migration.id} lost correlation`);
  }
  const invoiceOutcome = await handleUsagePackInvoicePaid(
    db,
    correlatedMigrationInvoice(invoice, migration),
  );
  if (!invoiceOutcome.handled) {
    throw new Error(
      `Usage pack migration invoice ${invoice.id} was not handled`,
    );
  }
  await completeMigrationInvitations(db, migration, invoice);
  L.debug("usage pack subscription migration completed", {
    migrationId: migration.id,
    orgId: migration.orgId,
    stripeSubscriptionId: migration.stripeSubscriptionId,
    invoiceId: invoice.id,
  });
  return {
    status: "active",
    orgId: migration.orgId,
    response: {
      status: "completed",
      effectiveAt: migration.effectiveAt.toISOString(),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    },
  };
}

async function failChangedMigration(
  db: Db,
  migration: MigrationRow,
): Promise<boolean> {
  const completedAt = nowDate();
  const [failed] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "failed",
      failureReason: "subscription_changed",
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        inArray(usagePackSubscriptionMigrations.status, [
          ...RECONCILING_MIGRATION_STATUSES,
        ]),
      ),
    )
    .returning({ id: usagePackSubscriptionMigrations.id });
  return failed !== undefined;
}

function migrationRecurringDuration(
  legacyItem: StripeSubscriptionItem,
): StripePriceRecurring {
  const recurring = legacyItem.price.recurring;
  if (!recurring) {
    throw new Error("Legacy subscription plan is not recurring");
  }
  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function migrationPhaseItems(
  subscription: StripeSubscription,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return { price: item.price.id, quantity: item.quantity ?? 1 };
  });
}

function migrationPhaseDiscounts(
  subscription: StripeSubscription,
): StripeSchedulePhaseDiscountParam[] {
  return (subscription.discounts ?? []).flatMap((discount) => {
    const id = stripeObjectId(discount);
    return id ? [{ discount: id }] : [];
  });
}

function migrationPhaseWithDiscounts(
  phase: StripeSchedulePhaseParam,
  discounts: readonly StripeSchedulePhaseDiscountParam[],
): StripeSchedulePhaseParam {
  return discounts.length === 0
    ? phase
    : { ...phase, discounts: [...discounts] };
}

function targetMigrationPhaseItems(
  subscription: StripeSubscription,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): StripeSchedulePhaseItemParam[] {
  const unrelated = subscription.items.data
    .filter((item) => {
      return (
        tierForKnownPriceId(item.price.id) === null &&
        usagePackUsdForKnownPriceId(item.price.id) === null
      );
    })
    .map((item) => {
      return { price: item.price.id, quantity: item.quantity ?? 1 };
    });
  return [
    ...unrelated,
    { price: migration.stripePlanPriceId, quantity: 1 },
    ...[...packageQuantities(selections)].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

function scheduledMigrationResponse(
  migration: MigrationRow,
): UsagePackMigrationConfirmResponse {
  return {
    status: "scheduled",
    effectiveAt: migration.effectiveAt.toISOString(),
    hostedInvoiceUrl: migration.hostedInvoiceUrl,
  };
}

async function scheduleMigration(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
  signal: AbortSignal | undefined,
): Promise<MigrationRow> {
  if (!legacyMigrationShape(migration, subscription)) {
    throw new Error(`Legacy subscription ${subscription.id} changed`);
  }
  const legacyItem = legacyPlanItem(subscription, migration.sourceTier);
  if (!legacyItem) {
    throw new Error(`Legacy subscription ${subscription.id} lost its plan`);
  }
  const stripe = getStripeClient();
  const createdSchedule = migration.stripeScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: migration.stripeSubscriptionId },
        {
          idempotencyKey: `usage-pack-migration:${migration.id}:schedule-create`,
        },
      );
  signal?.throwIfAborted();
  const scheduleId = migration.stripeScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a migration schedule ID");
  }
  const attachedScheduleId = stripeObjectId(subscription.schedule);
  if (attachedScheduleId && attachedScheduleId !== scheduleId) {
    throw new Error(`Legacy subscription ${subscription.id} schedule changed`);
  }
  const period = migrationPeriod(legacyItem);
  const discounts = migrationPhaseDiscounts(subscription);
  await stripe.subscriptionSchedules.update(
    scheduleId,
    {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        migrationPhaseWithDiscounts(
          {
            start_date: period.start,
            end_date: period.end,
            items: migrationPhaseItems(subscription),
            proration_behavior: "none",
          },
          discounts,
        ),
        migrationPhaseWithDiscounts(
          {
            start_date: period.end,
            duration: migrationRecurringDuration(legacyItem),
            items: targetMigrationPhaseItems(
              subscription,
              migration,
              selections,
            ),
            proration_behavior: "none",
          },
          discounts,
        ),
      ],
    },
    {
      idempotencyKey: `usage-pack-migration:${migration.id}:schedule-update`,
    },
  );
  signal?.throwIfAborted();
  const updatedAt = nowDate();
  const [scheduled] = await db
    .update(usagePackSubscriptionMigrations)
    .set({ status: "scheduled", stripeScheduleId: scheduleId, updatedAt })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        eq(usagePackSubscriptionMigrations.status, "applying"),
      ),
    )
    .returning();
  const persisted = scheduled ?? migration;
  L.debug("usage pack subscription migration scheduled", {
    migrationId: migration.id,
    orgId: migration.orgId,
    stripeScheduleId: scheduleId,
    effectiveAt: migration.effectiveAt.toISOString(),
  });
  return {
    ...persisted,
    status: "scheduled",
    stripeScheduleId: scheduleId,
  };
}

async function reconcileMigration(
  db: Db,
  migration: MigrationRow,
  signal?: AbortSignal,
  eventInvoice?: StripeInvoice,
): Promise<AppliedMigrationResult> {
  const selections = await loadMigrationSelections(db, migration.id);
  if (selections.length === 0) {
    throw new Error(`Usage pack migration ${migration.id} has no selections`);
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    migration.stripeSubscriptionId,
  );
  signal?.throwIfAborted();
  if (desiredMigrationShape(migration, selections, subscription)) {
    const persisted = await persistMigrationInvoiceState(
      db,
      migration,
      selections,
      subscription,
    );
    const invoiceId = eventInvoice?.id ?? persisted.stripeInvoiceId;
    const invoice = invoiceId
      ? await retrieveMigrationInvoice(invoiceId)
      : null;
    signal?.throwIfAborted();
    if (
      invoice &&
      migrationInvoiceMatchesSelections(invoice, persisted, selections)
    ) {
      return await finalizeAppliedMigration(
        db,
        persisted,
        selections,
        subscription,
        invoice,
      );
    }
    return {
      status: "active",
      orgId: migration.orgId,
      response: scheduledMigrationResponse(persisted),
    };
  }
  if (!legacyMigrationShape(migration, subscription)) {
    if (await failChangedMigration(db, migration)) {
      return { status: "failed", orgId: migration.orgId };
    }
    return { status: "failed", orgId: migration.orgId };
  }
  if (migration.status === "applying") {
    const scheduled = await scheduleMigration(
      db,
      migration,
      selections,
      subscription,
      signal,
    );
    return {
      status: "active",
      orgId: migration.orgId,
      response: scheduledMigrationResponse(scheduled),
    };
  }
  return {
    status: "active",
    orgId: migration.orgId,
    response: scheduledMigrationResponse(migration),
  };
}

async function claimMigrationConfirmation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly ownerIds: readonly string[];
  },
): Promise<
  | { readonly status: "ready"; readonly migration: MigrationRow }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" }
> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.orgId);
    const [migration] = await tx
      .select()
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, args.migrationId),
          eq(usagePackSubscriptionMigrations.orgId, args.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!migration) {
      return { status: "not_found" as const };
    }
    if (migration.status === "completed" || migration.status === "failed") {
      return { status: "conflict" as const };
    }
    if (migration.status === "previewed") {
      const selections = await loadMigrationSelections(tx, migration.id);
      if (!exactStoredOwnerIds(selections, args.ownerIds)) {
        const completedAt = nowDate();
        await tx
          .update(usagePackSubscriptionMigrations)
          .set({
            status: "failed",
            failureReason: "owners_changed",
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(usagePackSubscriptionMigrations.id, migration.id));
        return { status: "owners_changed" as const };
      }
      if (migration.previewExpiresAt <= nowDate()) {
        const completedAt = nowDate();
        await tx
          .update(usagePackSubscriptionMigrations)
          .set({
            status: "failed",
            failureReason: "preview_expired",
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(usagePackSubscriptionMigrations.id, migration.id));
        return { status: "expired" as const };
      }
      const [claimed] = await tx
        .update(usagePackSubscriptionMigrations)
        .set({ status: "applying", updatedAt: nowDate() })
        .where(
          and(
            eq(usagePackSubscriptionMigrations.id, migration.id),
            eq(usagePackSubscriptionMigrations.status, "previewed"),
          ),
        )
        .returning();
      if (!claimed) {
        return { status: "conflict" as const };
      }
      return { status: "ready" as const, migration: claimed };
    }
    return { status: "ready" as const, migration };
  });
}

export async function confirmUsagePackSubscriptionMigration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly ownerIds: readonly string[];
  },
  signal: AbortSignal,
): Promise<MigrationConfirmResult> {
  const claimed = await claimMigrationConfirmation(db, args);
  if (claimed.status !== "ready") {
    return claimed;
  }
  signal.throwIfAborted();
  const result = await reconcileMigration(db, claimed.migration, signal);
  if (result.status === "failed") {
    return { status: "conflict" };
  }
  return { status: "confirmed", response: result.response };
}

async function migrationForInvoice(
  db: Pick<Db, "select">,
  invoice: Pick<UsagePackInvoiceInput, "id" | "parent">,
): Promise<MigrationRow | null> {
  const subscriptionId = stripeObjectId(
    invoice.parent?.subscription_details?.subscription,
  );
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      or(
        eq(usagePackSubscriptionMigrations.stripeInvoiceId, invoice.id),
        subscriptionId
          ? and(
              eq(
                usagePackSubscriptionMigrations.stripeSubscriptionId,
                subscriptionId,
              ),
              inArray(usagePackSubscriptionMigrations.status, [
                ...RECONCILING_MIGRATION_STATUSES,
              ]),
            )
          : sql`false`,
      ),
    )
    .orderBy(desc(usagePackSubscriptionMigrations.createdAt))
    .limit(1);
  return migration ?? null;
}

export async function handleUsagePackMigrationInvoicePaid(
  db: Db,
  invoice: UsagePackInvoiceInput,
): Promise<UsagePackMigrationLifecycleOutcome> {
  if (!(await usagePackSubscriptionMigrationSchemaAvailable(db))) {
    return { handled: false, orgId: null };
  }
  const migration = await migrationForInvoice(db, invoice);
  if (!migration) {
    return { handled: false, orgId: null };
  }
  const currentInvoice = await retrieveMigrationInvoice(invoice.id);
  if (migration.stripeInvoiceId !== currentInvoice.id) {
    const selections = await loadMigrationSelections(db, migration.id);
    if (
      !migrationInvoiceMatchesSelections(currentInvoice, migration, selections)
    ) {
      return { handled: false, orgId: null };
    }
  }
  if (migration.status === "completed") {
    const outcome = await handleUsagePackInvoicePaid(
      db,
      correlatedMigrationInvoice(currentInvoice, migration),
    );
    return { handled: outcome.handled, orgId: migration.orgId };
  }
  const [updated] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      stripeInvoiceId: currentInvoice.id,
      stripePaymentIntentId:
        invoicePaymentIntentId(currentInvoice) ??
        migration.stripePaymentIntentId,
      hostedInvoiceUrl: currentInvoice.hosted_invoice_url,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackSubscriptionMigrations.id, migration.id))
    .returning();
  const result = await reconcileMigration(
    db,
    updated ?? migration,
    undefined,
    currentInvoice,
  );
  return { handled: true, orgId: result.orgId };
}

export async function handleUsagePackMigrationSubscriptionUpdated(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackMigrationLifecycleOutcome> {
  if (!(await usagePackSubscriptionMigrationSchemaAvailable(db))) {
    return { handled: false, orgId: null };
  }
  const usagePackSubscriptionId = usagePackSubscriptionIdFromMetadata(
    subscription.metadata,
  );
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      and(
        eq(
          usagePackSubscriptionMigrations.stripeSubscriptionId,
          subscription.id,
        ),
        inArray(usagePackSubscriptionMigrations.status, [
          ...RECONCILING_MIGRATION_STATUSES,
          ...(usagePackSubscriptionId ? [] : (["completed"] as const)),
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptionMigrations.createdAt))
    .limit(1);
  if (!migration) {
    return { handled: false, orgId: null };
  }
  if (migration.status === "completed") {
    const current = await getStripeClient().subscriptions.retrieve(
      migration.stripeSubscriptionId,
    );
    const outcome = await handleUsagePackSubscriptionUpdated(
      db,
      current as UsagePackSubscriptionInput,
    );
    if (!outcome.handled) {
      throw new Error(
        `Completed usage pack migration ${migration.id} lost correlation`,
      );
    }
    return { handled: true, orgId: migration.orgId };
  }
  const result = await reconcileMigration(db, migration);
  return { handled: true, orgId: result.orgId };
}

export async function reconcileUsagePackSubscriptionMigrations(
  db: Db,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}> {
  if (!(await usagePackSubscriptionMigrationSchemaAvailable(db))) {
    return { reconciled: 0, orgIds: [] };
  }
  const at = nowDate();
  await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.status, "previewed"),
        lte(usagePackSubscriptionMigrations.previewExpiresAt, at),
      ),
    );
  signal.throwIfAborted();
  const staleBefore = new Date(at.getTime() - RECONCILIATION_DELAY_MS);
  const candidates = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      or(
        and(
          eq(usagePackSubscriptionMigrations.status, "applying"),
          lte(usagePackSubscriptionMigrations.updatedAt, staleBefore),
        ),
        and(
          eq(usagePackSubscriptionMigrations.status, "scheduled"),
          lte(usagePackSubscriptionMigrations.effectiveAt, at),
        ),
      ),
    )
    .limit(100);
  signal.throwIfAborted();
  const orgIds = new Set<string>();
  let reconciled = 0;
  for (const candidate of candidates) {
    const result = await reconcileMigration(db, candidate, signal);
    orgIds.add(result.orgId);
    reconciled += 1;
  }
  return { reconciled, orgIds: [...orgIds] };
}
