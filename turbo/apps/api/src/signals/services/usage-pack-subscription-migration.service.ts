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
import { and, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripeInvoice,
  type StripeInvoiceLine,
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
const OPEN_MIGRATION_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
] as const;
const APPLYING_MIGRATION_STATUSES = ["applying", "pending_payment"] as const;
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
  readonly stripePlanPriceId: string;
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

function unixDate(value: number | null | undefined): Date | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? new Date(value * 1000)
    : null;
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

function activeMigrationSubscription(
  subscription: StripeSubscription,
): boolean {
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
  const stripePlanPriceId = activeUsagePackPlanPriceId(row.tier);
  if (
    !activeMigrationSubscription(subscription) ||
    stripeObjectId(subscription.customer) !== row.stripeCustomerId ||
    !legacyItem ||
    subscriptionHasUsagePackItems(subscription) ||
    !stripePlanPriceId
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
    stripePlanPriceId,
  };
}

function migrationState(
  migration: MigrationRow,
): UsagePackMigrationStateResponse {
  if (migration.status === "completed" || migration.status === "failed") {
    throw new Error(`Migration ${migration.id} is not open`);
  }
  return {
    tier: migration.tier,
    status: migration.status,
    migrationId: migration.id,
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
      status: "eligible",
      migrationId: null,
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
    readonly prorationTimestamp: number;
    readonly immediateAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly currency: string;
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
            "pending_payment",
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
        tier: context.org.tier,
        stripeCustomerId: context.org.stripeCustomerId,
        stripeSubscriptionId: context.org.stripeSubscriptionId,
        legacyStripePriceId: context.legacyItem.price.id,
        legacyStripeItemId: context.legacyItem.id,
        stripePlanPriceId: context.stripePlanPriceId,
        prorationTimestamp: args.prorationTimestamp,
        immediateAmountCents: args.immediateAmountCents,
        nextRecurringAmountCents: args.nextRecurringAmountCents,
        currency: args.currency,
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
  const requestedTimestamp = Math.floor(nowDate().getTime() / 1000);
  const prorationTimestamp = Math.min(
    Math.max(requestedTimestamp, period.start),
    period.end - 1,
  );
  const items = migrationUpdateItems(
    context.legacyItem.id,
    context.stripePlanPriceId,
    selections,
  );
  const stripe = getStripeClient();
  const [recurringPreview, immediatePreview] = await Promise.all([
    stripe.invoices.createPreview({
      subscription: context.subscription.id,
      preview_mode: "recurring",
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      },
    }),
    stripe.invoices.createPreview({
      subscription: context.subscription.id,
      preview_mode: "next",
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      },
    }),
  ]);
  signal.throwIfAborted();
  if (recurringPreview.currency !== immediatePreview.currency) {
    throw new Error("Stripe migration previews returned different currencies");
  }
  const immediateAmountCents = safeInvoiceAmount(immediatePreview, "immediate");
  const nextRecurringAmountCents = safeInvoiceAmount(
    recurringPreview,
    "recurring",
  );
  const createdAt = nowDate();
  const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS);
  const migration = await persistMigrationPreview(db, context, selections, {
    prorationTimestamp,
    immediateAmountCents,
    nextRecurringAmountCents,
    currency: recurringPreview.currency,
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
      tier: migration.tier,
      immediateAmountCents,
      nextRecurringAmountCents,
      currency: migration.currency,
      purchasedCredits,
      bonusCredits,
      totalCredits: purchasedCredits + bonusCredits,
      prorationDate: new Date(prorationTimestamp * 1000).toISOString(),
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
    (planItems[0].quantity ?? 1) !== 1
  ) {
    return false;
  }
  const expected = packageQuantities(selections);
  const actual = new Map<string, number>();
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
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
  const legacyItem = legacyPlanItem(subscription, migration.tier);
  if (!legacyItem) {
    return false;
  }
  const period = migrationPeriod(legacyItem);
  return (
    activeMigrationSubscription(subscription) &&
    stripeObjectId(subscription.customer) === migration.stripeCustomerId &&
    legacyItem.id === migration.legacyStripeItemId &&
    legacyItem.price.id === migration.legacyStripePriceId &&
    migration.prorationTimestamp >= period.start &&
    migration.prorationTimestamp < period.end &&
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

async function persistStripeMigrationState(
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
  const pendingExpiry = unixDate(subscription.pending_update?.expires_at);
  const updatedAt = nowDate();
  const [updated] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: subscription.pending_update ? "pending_payment" : "applying",
      stripeInvoiceId: invoice?.id ?? migration.stripeInvoiceId,
      stripePaymentIntentId:
        (invoice ? invoicePaymentIntentId(invoice) : null) ??
        migration.stripePaymentIntentId,
      hostedInvoiceUrl:
        invoice?.hosted_invoice_url ?? migration.hostedInvoiceUrl,
      stripePendingUpdateExpiresAt: pendingExpiry,
      updatedAt,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        inArray(usagePackSubscriptionMigrations.status, [
          ...APPLYING_MIGRATION_STATUSES,
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
        tier: migration.tier,
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

function migrationInvoiceMatchesSelections(
  invoice: StripeInvoice,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): boolean {
  if (
    stripeObjectId(invoice.customer) !== migration.stripeCustomerId ||
    invoice.currency !== migration.currency
  ) {
    return false;
  }
  const expected = packageQuantities(selections);
  const actual = new Map<string, number>();
  for (const line of invoice.lines.data) {
    const priceId = invoiceLinePriceId(line);
    if (!priceId || usagePackUsdForKnownPriceId(priceId) === null) {
      continue;
    }
    const quantity = line.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return false;
    }
    actual.set(priceId, (actual.get(priceId) ?? 0) + quantity);
  }
  return (
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
  amountPaidCents: number,
  selections: readonly MigrationSelectionRow[],
  credits: ReadonlyMap<string, SelectionCredits>,
): ReadonlyMap<string, number> {
  if (!Number.isSafeInteger(amountPaidCents) || amountPaidCents < 0) {
    throw new Error("Migration invoice has an invalid paid amount");
  }
  const totalWeight = selections.reduce((total, selection) => {
    return total + (credits.get(selection.id)?.weight ?? 0);
  }, 0);
  if (!(totalWeight > 0)) {
    throw new Error("Migration invoice has no package payment weight");
  }
  const ordered = [...selections].sort((left, right) => {
    return left.id.localeCompare(right.id);
  });
  const result = new Map<string, number>();
  let allocated = 0;
  for (const selection of ordered) {
    const weight = credits.get(selection.id)?.weight ?? 0;
    const amount = Math.floor((amountPaidCents * weight) / totalWeight);
    result.set(selection.id, amount);
    allocated += amount;
  }
  let remainder = amountPaidCents - allocated;
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
  const refundableAmount = payment?.amountPaidCents ?? 0;
  const paidAmounts = paidAmountsBySelection(
    refundableAmount,
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
        prorationTimestamp: migration.prorationTimestamp,
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
    tier: migration.tier,
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
        status: "processing",
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      },
    };
  }
  await materializeUsagePackSnapshot(db, migration, selections, subscription);
  const metadata = usagePackSubscriptionMetadata({
    orgId: migration.orgId,
    tier: migration.tier,
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
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    },
  };
}

async function failExpiredPendingMigration(
  db: Db,
  migration: MigrationRow,
): Promise<boolean> {
  const expiresAt = migration.stripePendingUpdateExpiresAt;
  if (!expiresAt || expiresAt > nowDate()) {
    return false;
  }
  const completedAt = nowDate();
  const [failed] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "failed",
      failureReason: "pending_update_expired",
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        eq(usagePackSubscriptionMigrations.status, "pending_payment"),
      ),
    )
    .returning({ id: usagePackSubscriptionMigrations.id });
  return failed !== undefined;
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
        eq(usagePackSubscriptionMigrations.status, "applying"),
      ),
    )
    .returning({ id: usagePackSubscriptionMigrations.id });
  return failed !== undefined;
}

async function applyMigrationUpdate(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
  signal: AbortSignal | undefined,
): Promise<StripeSubscription> {
  if (!legacyMigrationShape(migration, subscription)) {
    throw new Error(`Legacy subscription ${subscription.id} changed`);
  }
  const updated = await getStripeClient().subscriptions.update(
    migration.stripeSubscriptionId,
    {
      items: migrationUpdateItems(
        migration.legacyStripeItemId,
        migration.stripePlanPriceId,
        selections,
      ),
      billing_cycle_anchor: "unchanged",
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: migration.prorationTimestamp,
      expand: ["latest_invoice.payments.data.payment.payment_intent"],
    },
    { idempotencyKey: `usage-pack-migration:${migration.id}:apply` },
  );
  signal?.throwIfAborted();
  return updated;
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
  let subscription: StripeSubscription =
    await getStripeClient().subscriptions.retrieve(
      migration.stripeSubscriptionId,
    );
  signal?.throwIfAborted();
  if (subscription.pending_update) {
    const persisted = await persistStripeMigrationState(
      db,
      migration,
      selections,
      subscription,
    );
    return {
      status: "active",
      orgId: migration.orgId,
      response: {
        status: "pending_payment",
        hostedInvoiceUrl: persisted.hostedInvoiceUrl,
      },
    };
  }
  if (!desiredMigrationShape(migration, selections, subscription)) {
    if (migration.status === "pending_payment") {
      if (await failExpiredPendingMigration(db, migration)) {
        return { status: "failed", orgId: migration.orgId };
      }
      return {
        status: "active",
        orgId: migration.orgId,
        response: {
          status: "pending_payment",
          hostedInvoiceUrl: migration.hostedInvoiceUrl,
        },
      };
    }
    if (!legacyMigrationShape(migration, subscription)) {
      if (await failChangedMigration(db, migration)) {
        return { status: "failed", orgId: migration.orgId };
      }
      return {
        status: "active",
        orgId: migration.orgId,
        response: { status: "processing", hostedInvoiceUrl: null },
      };
    }
    subscription = await applyMigrationUpdate(
      db,
      migration,
      selections,
      subscription,
      signal,
    );
  }
  const persisted = await persistStripeMigrationState(
    db,
    migration,
    selections,
    subscription,
  );
  if (subscription.pending_update) {
    return {
      status: "active",
      orgId: migration.orgId,
      response: {
        status: "pending_payment",
        hostedInvoiceUrl: persisted.hostedInvoiceUrl,
      },
    };
  }
  if (!desiredMigrationShape(migration, selections, subscription)) {
    throw new Error(
      `Stripe did not apply usage pack migration ${migration.id}`,
    );
  }
  const invoiceId = eventInvoice?.id ?? persisted.stripeInvoiceId;
  const invoice = invoiceId ? await retrieveMigrationInvoice(invoiceId) : null;
  signal?.throwIfAborted();
  if (!invoice) {
    return {
      status: "active",
      orgId: migration.orgId,
      response: { status: "processing", hostedInvoiceUrl: null },
    };
  }
  return await finalizeAppliedMigration(
    db,
    persisted,
    selections,
    subscription,
    invoice,
  );
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
                ...APPLYING_MIGRATION_STATUSES,
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
          ...APPLYING_MIGRATION_STATUSES,
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
      and(
        inArray(usagePackSubscriptionMigrations.status, [
          ...APPLYING_MIGRATION_STATUSES,
        ]),
        or(
          lte(usagePackSubscriptionMigrations.updatedAt, staleBefore),
          and(
            isNotNull(
              usagePackSubscriptionMigrations.stripePendingUpdateExpiresAt,
            ),
            lte(
              usagePackSubscriptionMigrations.stripePendingUpdateExpiresAt,
              at,
            ),
          ),
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
