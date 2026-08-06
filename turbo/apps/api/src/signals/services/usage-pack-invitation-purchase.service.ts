import type { OrgRole } from "@vm0/api-contracts/contracts/org-members";
import type { UsagePackUsd } from "@vm0/api-contracts/contracts/zero-billing";
import {
  usagePackAllocations,
  usagePackInvitationPurchases,
  usagePackSubscriptions,
} from "@vm0/db/schema/usage-pack-subscription";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  listAllOrganizationMemberships,
  listAllPendingOrganizationInvitations,
} from "../external/clerk-organization-lists";
import type { ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripePaymentIntent,
  type StripePrice,
  type StripeRefund,
} from "../external/stripe-client";
import { onRejection } from "../utils";
import {
  lockUsagePackBillingOrg,
  previewUsagePackAllocationAddition,
  syncUsagePackAllocationProjection,
  type UsagePackAllocationAdditionPreview,
} from "./usage-pack-allocation-change.service";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import { loadUsagePackCatalog } from "./usage-pack-subscription.service";
import {
  isCurrentStripePreviewMetadata,
  stripePreviewMetadata,
} from "./stripe-preview-metadata.service";
import { activeUsagePackPriceId } from "./zero-billing-checkout.service";

const PURPOSE = "usage_pack_invitation_purchase";
const PURCHASE_ID_METADATA_KEY = "usagePackInvitationPurchaseId";
const RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const MIN_CHECKOUT_DURATION_SECONDS = 30 * 60;
const MAX_CHECKOUT_DURATION_SECONDS = 24 * 60 * 60;
const OPEN_INVITATION_PURCHASE_STATUSES = [
  "checkout_pending",
  "payment_succeeded",
  "creating_invitation",
  "invitation_pending",
  "accepted_pending_activation",
  "activating",
] as const;
const TERMINAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackInvitationPurchaseRow =
  typeof usagePackInvitationPurchases.$inferSelect;
type UsagePackInvitationPurchaseStatus =
  UsagePackInvitationPurchaseRow["status"];
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type StripeObjectReference = string | { readonly id: string };

interface PendingInvitationPurchaseArgs {
  readonly subscription: UsagePackSubscriptionRow;
  readonly orgId: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly inviterUserId: string;
  readonly usagePackUsd: UsagePackUsd;
  readonly stripePriceId: string;
  readonly preview: UsagePackAllocationAdditionPreview;
  readonly unitAmountCents: number;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly checkoutExpiresAt: number;
}

interface StripeInvitationCheckoutArgs {
  readonly subscription: UsagePackSubscriptionRow;
  readonly preview: UsagePackAllocationAdditionPreview;
  readonly price: StripePrice;
  readonly purchaseId: string;
  readonly checkoutExpiresAt: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface SuccessfulPaymentArgs {
  readonly purchaseId: string;
  readonly checkoutSessionId?: string;
  readonly paymentIntentId: string;
  readonly customerId: string;
  readonly amountPaidCents: number;
  readonly currency: string;
  readonly paidAt: Date;
}

interface UsagePackInvitationAcceptanceArgs {
  readonly orgId: string;
  readonly invitationId?: string;
  readonly userId: string;
  readonly acceptedAt: Date;
  readonly normalizedEmail?: string;
  readonly purchaseId?: string;
}

interface UsagePackInvitationCheckoutSessionInput {
  readonly id: string;
  readonly customer: StripeObjectReference | null;
  readonly payment_intent?: StripeObjectReference | null;
  readonly metadata: Record<string, string> | null;
  readonly mode?: string | null;
  readonly payment_status?: string | null;
  readonly amount_total?: number | null;
  readonly currency?: string | null;
}

type CreateUsagePackInvitationCheckoutResult =
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "not_found" }
  | { readonly status: "conflict" };

type RevokeUsagePackInvitationResult =
  | { readonly status: "not_found" }
  | { readonly status: "accepted" }
  | { readonly status: "revoked" };

interface ClerkMembershipIdentity {
  readonly email: string;
  readonly userId: string;
  readonly createdAt: Date;
}

const ACCEPTABLE_INVITATION_PURCHASE_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "payment_succeeded",
      "creating_invitation",
      "invitation_pending",
    ]),
  );
const ACCEPTANCE_IN_PROGRESS_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "accepted_pending_activation",
      "activating",
    ]),
  );
const ACCEPTED_PURCHASE_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "accepted",
      "accepted_pending_activation",
      "activating",
    ]),
  );
const IGNORED_ACCEPTANCE_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "checkout_pending",
      "failed",
      "refund_pending",
      "refunding",
      "refunded",
      "accepted",
    ]),
  );
const REFUND_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "refund_pending",
      "refunding",
      "refunded",
    ]),
  );

function stripeObjectId(
  value: StripeObjectReference | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function stringPropertyOf(value: unknown, key: string): string | null {
  const property = propertyOf(value, key);
  return typeof property === "string" ? property : null;
}

function numberPropertyOf(value: unknown, key: string): number | null {
  const property = propertyOf(value, key);
  return typeof property === "number" && Number.isFinite(property)
    ? property
    : null;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function purchaseIdFromMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  return metadata?.purpose === PURPOSE
    ? (metadata[PURCHASE_ID_METADATA_KEY] ?? null)
    : null;
}

function clerkInvitationPurchaseId(invitation: unknown): string | null {
  const metadata =
    propertyOf(invitation, "privateMetadata") ??
    propertyOf(invitation, "private_metadata");
  return stringPropertyOf(metadata, PURCHASE_ID_METADATA_KEY);
}

function clerkMembershipIdentity(
  membership: unknown,
): ClerkMembershipIdentity | null {
  const publicUserData =
    propertyOf(membership, "publicUserData") ??
    propertyOf(membership, "public_user_data");
  const email = stringPropertyOf(publicUserData, "identifier");
  const userId =
    stringPropertyOf(publicUserData, "userId") ??
    stringPropertyOf(publicUserData, "user_id");
  const createdAt =
    numberPropertyOf(membership, "createdAt") ??
    numberPropertyOf(membership, "created_at");
  return email && userId && createdAt !== null
    ? { email: normalizedEmail(email), userId, createdAt: new Date(createdAt) }
    : null;
}

async function lockPurchase(
  tx: Pick<WriteTx, "execute">,
  purchaseId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage_pack_invitation:${purchaseId}`}, 0))`,
  );
}

async function lockInvitationEmail(
  tx: Pick<WriteTx, "execute">,
  orgId: string,
  email: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage_pack_invitation_email:${orgId}:${email}`}, 0))`,
  );
}

function checkoutExpiration(currentPeriodEnd: Date): number | null {
  const current = Math.floor(nowDate().getTime() / 1000);
  const expiration = Math.min(
    Math.floor(currentPeriodEnd.getTime() / 1000),
    current + MAX_CHECKOUT_DURATION_SECONDS,
  );
  return expiration >= current + MIN_CHECKOUT_DURATION_SECONDS
    ? expiration
    : null;
}

export async function usagePackInvitationPurchaseSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('usage_pack_invitation_purchases') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

export async function currentUsagePackSubscriptionForOrg(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<UsagePackSubscriptionRow | null> {
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
  return subscription ?? null;
}

async function emailAlreadyBelongsToOrg(
  clerk: ClerkClient,
  orgId: string,
  email: string,
): Promise<boolean> {
  const [memberships, invitations] = await Promise.all([
    listAllOrganizationMemberships(clerk.organizations, orgId),
    listAllPendingOrganizationInvitations(clerk.organizations, orgId),
  ]);
  return (
    memberships.some((membership) => {
      return clerkMembershipIdentity(membership)?.email === email;
    }) ||
    invitations.some((invitation) => {
      return normalizedEmail(invitation.emailAddress) === email;
    })
  );
}

function stripeProductId(price: StripePrice): string {
  if (typeof price.product === "string") {
    return price.product;
  }
  if ("deleted" in price.product) {
    throw new Error(
      `Usage pack Price ${price.id} references a deleted Product`,
    );
  }
  return price.product.id;
}

function checkoutMetadata(purchaseId: string): Record<string, string> {
  return {
    ...stripePreviewMetadata(),
    purpose: PURPOSE,
    [PURCHASE_ID_METADATA_KEY]: purchaseId,
  };
}

async function insertPendingInvitationPurchase(
  db: Db,
  args: PendingInvitationPurchaseArgs,
): Promise<string | null> {
  return await db.transaction(async (tx) => {
    await lockInvitationEmail(tx, args.orgId, args.email);
    const [created] = await tx
      .insert(usagePackInvitationPurchases)
      .values({
        usagePackSubscriptionId: args.subscription.id,
        orgId: args.orgId,
        normalizedEmail: args.email,
        role: args.role,
        inviterUserId: args.inviterUserId,
        usagePackUsd: args.usagePackUsd,
        stripePriceId: args.stripePriceId,
        currentPeriodStart: args.preview.currentPeriodStart,
        currentPeriodEnd: args.preview.currentPeriodEnd,
        prorationTimestamp: args.preview.prorationTimestamp,
        unitAmountCents: args.unitAmountCents,
        expectedAmountCents: args.preview.amountCents,
        currency: args.preview.currency,
        purchasedCredits: args.purchasedCredits,
        bonusCredits: args.bonusCredits,
        stripeCheckoutExpiresAt: new Date(args.checkoutExpiresAt * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: usagePackInvitationPurchases.id });
    return created?.id ?? null;
  });
}

async function createStripeInvitationCheckoutSession(
  db: Db,
  args: StripeInvitationCheckoutArgs,
  signal: AbortSignal,
): Promise<string> {
  const metadata = checkoutMetadata(args.purchaseId);
  const session = await getStripeClient().checkout.sessions.create(
    {
      mode: "payment",
      customer: args.subscription.stripeCustomerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: args.preview.currency,
            product: stripeProductId(args.price),
            unit_amount: args.preview.amountCents,
          },
        },
      ],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      expires_at: args.checkoutExpiresAt,
      metadata,
      payment_intent_data: { metadata },
    },
    { idempotencyKey: `usage-pack-invitation:${args.purchaseId}:checkout` },
  );
  signal.throwIfAborted();
  if (!session.url) {
    throw new Error("Stripe checkout session did not return a URL");
  }
  await db
    .update(usagePackInvitationPurchases)
    .set({
      stripeCheckoutSessionId: session.id,
      stripeCheckoutExpiresAt:
        typeof session.expires_at === "number"
          ? new Date(session.expires_at * 1000)
          : new Date(args.checkoutExpiresAt * 1000),
      updatedAt: nowDate(),
    })
    .where(eq(usagePackInvitationPurchases.id, args.purchaseId));
  signal.throwIfAborted();
  return session.url;
}

async function createStripeInvitationCheckout(
  db: Db,
  args: StripeInvitationCheckoutArgs,
  signal: AbortSignal,
): Promise<string> {
  return await onRejection(
    createStripeInvitationCheckoutSession(db, args, signal),
    async () => {
      await db
        .update(usagePackInvitationPurchases)
        .set({
          status: "failed",
          failureReason: "checkout_creation_failed",
          updatedAt: nowDate(),
        })
        .where(eq(usagePackInvitationPurchases.id, args.purchaseId));
    },
  );
}

export async function createUsagePackInvitationCheckout(
  db: Db,
  clerk: ClerkClient,
  args: {
    readonly orgId: string;
    readonly inviterUserId: string;
    readonly email: string;
    readonly role: OrgRole;
    readonly usagePackUsd: UsagePackUsd;
    readonly successUrl: string;
    readonly cancelUrl: string;
  },
  signal: AbortSignal,
): Promise<CreateUsagePackInvitationCheckoutResult> {
  const subscription = await currentUsagePackSubscriptionForOrg(db, args.orgId);
  if (!subscription?.stripeSubscriptionId) {
    return { status: "not_found" };
  }
  if (subscription.cancelAtPeriodEnd) {
    return { status: "conflict" };
  }
  const email = normalizedEmail(args.email);
  if (await emailAlreadyBelongsToOrg(clerk, args.orgId, email)) {
    return { status: "conflict" };
  }
  signal.throwIfAborted();

  const stripePriceId = activeUsagePackPriceId(args.usagePackUsd);
  if (!stripePriceId) {
    throw new Error(`Usage pack $${args.usagePackUsd} Price is not configured`);
  }
  const catalog = await loadUsagePackCatalog();
  const catalogItem = catalog.find((item) => {
    return item.usagePackUsd === args.usagePackUsd;
  });
  if (!catalogItem) {
    throw new Error(`Usage pack $${args.usagePackUsd} is not in the catalog`);
  }
  const preview = await previewUsagePackAllocationAddition(
    db,
    {
      usagePackSubscriptionId: subscription.id,
      stripePriceId,
    },
    signal,
  );
  if (preview.amountCents <= 0) {
    return { status: "conflict" };
  }
  const stripe = getStripeClient();
  const price = await stripe.prices.retrieve(stripePriceId, {
    expand: ["product"],
  });
  signal.throwIfAborted();
  if (
    price.currency !== preview.currency ||
    price.unit_amount === null ||
    price.unit_amount <= 0
  ) {
    throw new Error("Usage pack invitation Price does not match its preview");
  }
  const unitAmountCents = price.unit_amount;
  const purchasedCredits = Math.floor(
    (catalogItem.purchasedCredits * preview.amountCents) / unitAmountCents,
  );
  const bonusCredits = Math.floor(
    (catalogItem.bonusCredits * preview.amountCents) / unitAmountCents,
  );
  if (purchasedCredits <= 0) {
    return { status: "conflict" };
  }
  const checkoutExpiresAt = checkoutExpiration(preview.currentPeriodEnd);
  if (checkoutExpiresAt === null) {
    return { status: "conflict" };
  }

  const purchaseId = await insertPendingInvitationPurchase(db, {
    subscription,
    orgId: args.orgId,
    email,
    role: args.role,
    inviterUserId: args.inviterUserId,
    usagePackUsd: args.usagePackUsd,
    stripePriceId,
    preview,
    unitAmountCents,
    purchasedCredits,
    bonusCredits,
    checkoutExpiresAt,
  });
  if (!purchaseId) {
    return { status: "conflict" };
  }
  signal.throwIfAborted();
  const url = await createStripeInvitationCheckout(
    db,
    {
      subscription,
      preview,
      price,
      purchaseId,
      checkoutExpiresAt,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
    },
    signal,
  );
  return { status: "ready", url };
}

async function loadPurchase(
  db: Pick<Db, "select">,
  purchaseId: string,
): Promise<UsagePackInvitationPurchaseRow | null> {
  const [purchase] = await db
    .select()
    .from(usagePackInvitationPurchases)
    .where(eq(usagePackInvitationPurchases.id, purchaseId))
    .limit(1);
  return purchase ?? null;
}

function validateSuccessfulPayment(
  purchase: UsagePackInvitationPurchaseRow,
  stripeCustomerId: string | null | undefined,
  args: SuccessfulPaymentArgs,
): void {
  if (
    stripeCustomerId !== args.customerId ||
    (args.checkoutSessionId &&
      purchase.stripeCheckoutSessionId &&
      purchase.stripeCheckoutSessionId !== args.checkoutSessionId) ||
    purchase.currency !== args.currency
  ) {
    throw new Error("Stripe invitation payment does not match local billing");
  }
  if (
    purchase.stripePaymentIntentId &&
    purchase.stripePaymentIntentId !== args.paymentIntentId
  ) {
    throw new Error("Invitation purchase has a different PaymentIntent");
  }
  if (
    purchase.amountPaidCents !== null &&
    purchase.amountPaidCents !== args.amountPaidCents
  ) {
    throw new Error("Invitation purchase has a different paid amount");
  }
}

async function supersedeCompetingPendingCheckout(
  tx: WriteTx,
  purchase: UsagePackInvitationPurchaseRow,
): Promise<boolean> {
  const [competing] = await tx
    .select({
      id: usagePackInvitationPurchases.id,
      status: usagePackInvitationPurchases.status,
    })
    .from(usagePackInvitationPurchases)
    .where(
      and(
        ne(usagePackInvitationPurchases.id, purchase.id),
        eq(usagePackInvitationPurchases.orgId, purchase.orgId),
        eq(
          usagePackInvitationPurchases.normalizedEmail,
          purchase.normalizedEmail,
        ),
        inArray(
          usagePackInvitationPurchases.status,
          OPEN_INVITATION_PURCHASE_STATUSES,
        ),
      ),
    )
    .limit(1);
  if (competing?.status === "checkout_pending") {
    await tx
      .update(usagePackInvitationPurchases)
      .set({
        status: "failed",
        failureReason: "superseded_by_paid_purchase",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, competing.id),
          eq(usagePackInvitationPurchases.status, "checkout_pending"),
        ),
      );
  }
  return competing !== undefined && competing.status !== "checkout_pending";
}

async function recordSuccessfulPayment(
  db: Db,
  args: SuccessfulPaymentArgs,
): Promise<UsagePackInvitationPurchaseRow> {
  return await db.transaction(async (tx) => {
    await lockPurchase(tx, args.purchaseId);
    const purchase = await loadPurchase(tx, args.purchaseId);
    if (!purchase) {
      throw new Error(
        `Unknown usage pack invitation purchase ${args.purchaseId}`,
      );
    }
    const [subscription] = await tx
      .select({ stripeCustomerId: usagePackSubscriptions.stripeCustomerId })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, purchase.usagePackSubscriptionId))
      .limit(1);
    validateSuccessfulPayment(purchase, subscription?.stripeCustomerId, args);
    if (purchase.status === "refunded") {
      return purchase;
    }
    if (
      purchase.status !== "checkout_pending" &&
      purchase.status !== "failed" &&
      purchase.status !== "payment_succeeded"
    ) {
      return purchase;
    }
    await lockInvitationEmail(tx, purchase.orgId, purchase.normalizedEmail);
    const superseded = await supersedeCompetingPendingCheckout(tx, purchase);
    const invalidPayment =
      args.amountPaidCents !== purchase.expectedAmountCents ||
      args.paidAt >= purchase.currentPeriodEnd;
    const requiresRefund = superseded || invalidPayment;
    const [updated] = await tx
      .update(usagePackInvitationPurchases)
      .set({
        stripeCheckoutSessionId:
          args.checkoutSessionId ?? purchase.stripeCheckoutSessionId,
        stripePaymentIntentId: args.paymentIntentId,
        amountPaidCents: args.amountPaidCents,
        paidAt: args.paidAt,
        status: requiresRefund ? "refund_pending" : "payment_succeeded",
        failureReason: superseded
          ? "superseded_invitation_payment"
          : invalidPayment
            ? "invalid_or_expired_payment"
            : null,
        updatedAt: nowDate(),
      })
      .where(eq(usagePackInvitationPurchases.id, purchase.id))
      .returning();
    if (!updated) {
      throw new Error("Failed to record invitation payment");
    }
    return updated;
  });
}

async function claimInvitationCreation(
  db: Db,
  purchaseId: string,
  allowRecovery: boolean,
): Promise<UsagePackInvitationPurchaseRow | null> {
  return await db.transaction(async (tx) => {
    await lockPurchase(tx, purchaseId);
    const purchase = await loadPurchase(tx, purchaseId);
    if (!purchase || purchase.clerkInvitationId || purchase.allocationId) {
      return null;
    }
    const staleBefore = new Date(nowDate().getTime() - RECONCILIATION_DELAY_MS);
    const canClaim =
      purchase.status === "payment_succeeded" ||
      (allowRecovery &&
        purchase.status === "creating_invitation" &&
        purchase.updatedAt <= staleBefore);
    if (!canClaim) {
      return null;
    }
    const [claimed] = await tx
      .update(usagePackInvitationPurchases)
      .set({ status: "creating_invitation", updatedAt: nowDate() })
      .where(eq(usagePackInvitationPurchases.id, purchase.id))
      .returning();
    return claimed ?? null;
  });
}

async function persistInvitation(
  db: Db,
  purchase: UsagePackInvitationPurchaseRow,
  invitationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPurchase(tx, purchase.id);
    const current = await loadPurchase(tx, purchase.id);
    if (!current) {
      throw new Error(`Unknown usage pack invitation purchase ${purchase.id}`);
    }
    if (current.clerkInvitationId) {
      if (current.clerkInvitationId !== invitationId) {
        throw new Error(
          "Invitation purchase resolved a different Clerk invite",
        );
      }
      return;
    }
    if (current.status !== "creating_invitation") {
      return;
    }
    const [inserted] = await tx
      .insert(usagePackAllocations)
      .values({
        usagePackSubscriptionId: current.usagePackSubscriptionId,
        orgId: current.orgId,
        invitationId,
        usagePackUsd: current.usagePackUsd,
        stripePriceId: current.stripePriceId,
        status: "paid_pending_invitation",
        currentPeriodStart: current.currentPeriodStart,
        currentPeriodEnd: current.currentPeriodEnd,
      })
      .onConflictDoNothing()
      .returning({ id: usagePackAllocations.id });
    const allocation =
      inserted ??
      (
        await tx
          .select({ id: usagePackAllocations.id })
          .from(usagePackAllocations)
          .where(
            and(
              eq(usagePackAllocations.orgId, current.orgId),
              eq(usagePackAllocations.invitationId, invitationId),
              eq(usagePackAllocations.status, "paid_pending_invitation"),
            ),
          )
          .limit(1)
      )[0];
    if (!allocation) {
      throw new Error("Failed to create paid pending invitation allocation");
    }
    await tx
      .update(usagePackInvitationPurchases)
      .set({
        allocationId: allocation.id,
        clerkInvitationId: invitationId,
        status: "invitation_pending",
        updatedAt: nowDate(),
      })
      .where(eq(usagePackInvitationPurchases.id, current.id));
  });
}

async function ensurePaidInvitationCreated(
  db: Db,
  clerk: ClerkClient,
  purchaseId: string,
  allowRecovery: boolean,
): Promise<void> {
  const purchase = await claimInvitationCreation(db, purchaseId, allowRecovery);
  if (!purchase) {
    return;
  }
  const membership = await membershipForPurchase(clerk, purchase);
  if (membership) {
    await handleUsagePackInvitationAccepted(db, {
      orgId: purchase.orgId,
      ...(purchase.clerkInvitationId
        ? { invitationId: purchase.clerkInvitationId }
        : {}),
      purchaseId: purchase.id,
      userId: membership.userId,
      acceptedAt: membership.createdAt,
      normalizedEmail: membership.email,
    });
    return;
  }
  const pending = await listAllPendingOrganizationInvitations(
    clerk.organizations,
    purchase.orgId,
  );
  const existing = pending.find((invitation) => {
    return clerkInvitationPurchaseId(invitation) === purchase.id;
  });
  if (nowDate() >= purchase.currentPeriodEnd) {
    if (existing) {
      await clerk.organizations.revokeOrganizationInvitation({
        organizationId: purchase.orgId,
        invitationId: existing.id,
      });
    }
    const [expired] = await db
      .update(usagePackInvitationPurchases)
      .set({
        status: "refund_pending",
        ...(existing ? { clerkInvitationId: existing.id } : {}),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchase.id),
          eq(usagePackInvitationPurchases.status, "creating_invitation"),
        ),
      )
      .returning({ id: usagePackInvitationPurchases.id });
    if (expired) {
      await refundPurchase(db, purchase.id, allowRecovery);
    }
    return;
  }
  const invitation =
    existing ??
    (await clerk.organizations.createOrganizationInvitation({
      organizationId: purchase.orgId,
      emailAddress: purchase.normalizedEmail,
      inviterUserId: purchase.inviterUserId,
      role: purchase.role === "admin" ? "org:admin" : "org:member",
      redirectUrl: env("APP_URL"),
      expiresInDays: Math.max(
        1,
        Math.ceil(
          (purchase.currentPeriodEnd.getTime() - nowDate().getTime()) /
            (24 * 60 * 60 * 1000),
        ),
      ),
      privateMetadata: {
        [PURCHASE_ID_METADATA_KEY]: purchase.id,
      },
    }));
  await persistInvitation(db, purchase, invitation.id);
}

async function finalizeRefund(
  db: Db,
  purchaseId: string,
  refundId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPurchase(tx, purchaseId);
    const purchase = await loadPurchase(tx, purchaseId);
    if (!purchase || purchase.status === "refunded") {
      return;
    }
    const at = nowDate();
    if (purchase.allocationId) {
      await tx
        .update(usagePackAllocations)
        .set({ status: "inactive", updatedAt: at })
        .where(eq(usagePackAllocations.id, purchase.allocationId));
    }
    await tx
      .update(usagePackInvitationPurchases)
      .set({
        status: "refunded",
        stripeRefundId: refundId,
        refundedAt: at,
        updatedAt: at,
      })
      .where(eq(usagePackInvitationPurchases.id, purchase.id));
  });
}

async function recordFailedRefund(
  db: Db,
  purchase: UsagePackInvitationPurchaseRow,
  refundId: string,
): Promise<void> {
  await db
    .update(usagePackInvitationPurchases)
    .set({
      status: "refund_pending",
      stripeRefundId: null,
      refundAttempt: purchase.refundAttempt + 1,
      failureReason: `stripe_refund_failed:${refundId}`,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackInvitationPurchases.id, purchase.id));
}

async function applyStripeRefundState(
  db: Db,
  purchase: UsagePackInvitationPurchaseRow,
  refund: StripeRefund,
): Promise<void> {
  if (refund.status === "succeeded") {
    await finalizeRefund(db, purchase.id, refund.id);
    return;
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    await recordFailedRefund(db, purchase, refund.id);
    return;
  }
  await db
    .update(usagePackInvitationPurchases)
    .set({
      status: "refunding",
      stripeRefundId: refund.id,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackInvitationPurchases.id, purchase.id));
}

async function refundPurchase(
  db: Db,
  purchaseId: string,
  allowRecovery: boolean,
): Promise<void> {
  const purchase = await db.transaction(async (tx) => {
    await lockPurchase(tx, purchaseId);
    const current = await loadPurchase(tx, purchaseId);
    if (!current || current.status === "refunded") {
      return null;
    }
    const staleBefore = new Date(nowDate().getTime() - RECONCILIATION_DELAY_MS);
    const canClaim =
      current.status === "refund_pending" ||
      (allowRecovery &&
        current.status === "refunding" &&
        current.updatedAt <= staleBefore);
    if (!canClaim) {
      return null;
    }
    const [claimed] = await tx
      .update(usagePackInvitationPurchases)
      .set({ status: "refunding", updatedAt: nowDate() })
      .where(eq(usagePackInvitationPurchases.id, current.id))
      .returning();
    return claimed ?? null;
  });
  if (!purchase) {
    return;
  }
  if (!purchase.amountPaidCents || !purchase.stripePaymentIntentId) {
    throw new Error("Paid invitation is missing its dedicated PaymentIntent");
  }
  const stripe = getStripeClient();
  if (purchase.stripeRefundId) {
    const refund = await stripe.refunds.retrieve(purchase.stripeRefundId);
    await applyStripeRefundState(db, purchase, refund);
    return;
  }
  const refund = await stripe.refunds.create(
    {
      payment_intent: purchase.stripePaymentIntentId,
      amount: purchase.amountPaidCents,
      metadata: checkoutMetadata(purchase.id),
    },
    {
      idempotencyKey: `usage-pack-invitation:${purchase.id}:refund:${purchase.refundAttempt}`,
    },
  );
  await applyStripeRefundState(db, purchase, refund);
}

async function handleRecordedPayment(
  db: Db,
  clerk: ClerkClient,
  purchase: UsagePackInvitationPurchaseRow,
): Promise<void> {
  if (purchase.status === "refund_pending") {
    await refundPurchase(db, purchase.id, false);
    return;
  }
  await ensurePaidInvitationCreated(db, clerk, purchase.id, false);
}

export async function handleUsagePackInvitationCheckoutPaid(
  db: Db,
  clerk: ClerkClient,
  session: UsagePackInvitationCheckoutSessionInput,
  paidAt: Date,
): Promise<{ readonly handled: boolean; readonly orgId: string | null }> {
  const purchaseId = purchaseIdFromMetadata(session.metadata);
  if (!purchaseId) {
    return { handled: false, orgId: null };
  }
  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return { handled: true, orgId: null };
  }
  const paymentIntentId = stripeObjectId(session.payment_intent);
  const customerId = stripeObjectId(session.customer);
  const amountTotal = session.amount_total;
  if (
    !paymentIntentId ||
    !customerId ||
    typeof amountTotal !== "number" ||
    !Number.isSafeInteger(amountTotal) ||
    amountTotal < 0 ||
    !session.currency
  ) {
    throw new Error("Paid invitation Checkout Session is incomplete");
  }
  const purchase = await recordSuccessfulPayment(db, {
    purchaseId,
    checkoutSessionId: session.id,
    paymentIntentId,
    customerId,
    amountPaidCents: amountTotal,
    currency: session.currency,
    paidAt,
  });
  await handleRecordedPayment(db, clerk, purchase);
  return { handled: true, orgId: purchase.orgId };
}

export async function handleUsagePackInvitationPaymentIntentSucceeded(
  db: Db,
  clerk: ClerkClient,
  paymentIntent: StripePaymentIntent,
  paidAt: Date,
): Promise<{ readonly handled: boolean; readonly orgId: string | null }> {
  const purchaseId = purchaseIdFromMetadata(paymentIntent.metadata);
  if (!purchaseId) {
    return { handled: false, orgId: null };
  }
  if (!isCurrentStripePreviewMetadata(paymentIntent.metadata)) {
    return { handled: true, orgId: null };
  }
  const customerId = stripeObjectId(paymentIntent.customer);
  if (!customerId || paymentIntent.status !== "succeeded") {
    return { handled: true, orgId: null };
  }
  const purchase = await recordSuccessfulPayment(db, {
    purchaseId,
    paymentIntentId: paymentIntent.id,
    customerId,
    amountPaidCents: paymentIntent.amount_received,
    currency: paymentIntent.currency,
    paidAt,
  });
  await handleRecordedPayment(db, clerk, purchase);
  return { handled: true, orgId: purchase.orgId };
}

export async function handleUsagePackInvitationCheckoutFailed(
  db: Db,
  session: UsagePackInvitationCheckoutSessionInput,
): Promise<boolean> {
  const purchaseId = purchaseIdFromMetadata(session.metadata);
  if (!purchaseId) {
    return false;
  }
  await db
    .update(usagePackInvitationPurchases)
    .set({
      status: "failed",
      failureReason: "checkout_failed_or_expired",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(usagePackInvitationPurchases.id, purchaseId),
        eq(usagePackInvitationPurchases.stripeCheckoutSessionId, session.id),
        eq(usagePackInvitationPurchases.status, "checkout_pending"),
      ),
    );
  return true;
}

async function ensureAcceptedInvitationSnapshot(
  tx: WriteTx,
  purchase: UsagePackInvitationPurchaseRow,
  invitationId: string | undefined,
  userId: string,
): Promise<string> {
  if (purchase.allocationId) {
    if (
      invitationId &&
      purchase.clerkInvitationId &&
      purchase.clerkInvitationId !== invitationId
    ) {
      throw new Error("Accepted Clerk invitation does not match its purchase");
    }
    return purchase.allocationId;
  }
  const [allocation] = await tx
    .insert(usagePackAllocations)
    .values({
      usagePackSubscriptionId: purchase.usagePackSubscriptionId,
      orgId: purchase.orgId,
      userId: invitationId ? null : userId,
      invitationId: invitationId ?? null,
      usagePackUsd: purchase.usagePackUsd,
      stripePriceId: purchase.stripePriceId,
      status: "paid_pending_invitation",
      currentPeriodStart: purchase.currentPeriodStart,
      currentPeriodEnd: purchase.currentPeriodEnd,
    })
    .returning({ id: usagePackAllocations.id });
  if (!allocation) {
    throw new Error("Failed to recover accepted invitation allocation");
  }
  return allocation.id;
}

async function activateAcceptedPurchase(
  db: Db,
  purchaseId: string,
  signal: AbortSignal | undefined,
  allowRecovery: boolean,
): Promise<void> {
  const purchase = await db.transaction(async (tx) => {
    await lockPurchase(tx, purchaseId);
    const current = await loadPurchase(tx, purchaseId);
    if (!current || current.status === "accepted") {
      return null;
    }
    const staleBefore = new Date(nowDate().getTime() - RECONCILIATION_DELAY_MS);
    const canClaim =
      current.status === "accepted_pending_activation" ||
      (allowRecovery &&
        current.status === "activating" &&
        current.updatedAt <= staleBefore);
    if (!canClaim) {
      return null;
    }
    const [claimed] = await tx
      .update(usagePackInvitationPurchases)
      .set({ status: "activating", updatedAt: nowDate() })
      .where(eq(usagePackInvitationPurchases.id, current.id))
      .returning();
    return claimed ?? null;
  });
  if (!purchase?.acceptedUserId || !purchase.allocationId) {
    return;
  }
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, purchase.orgId);
    await lockPurchase(tx, purchase.id);
    const current = await loadPurchase(tx, purchase.id);
    if (!current || current.status === "accepted") {
      return;
    }
    if (
      current.status !== "activating" ||
      current.acceptedUserId !== purchase.acceptedUserId ||
      current.allocationId !== purchase.allocationId
    ) {
      throw new Error("Invitation acceptance changed during activation");
    }
    const acceptedUserId = current.acceptedUserId;
    const allocationId = current.allocationId;
    if (!acceptedUserId || !allocationId) {
      throw new Error(
        "Invitation acceptance is missing its user or allocation",
      );
    }
    await syncUsagePackAllocationProjection(
      tx,
      {
        usagePackSubscriptionId: current.usagePackSubscriptionId,
        operationId: `invitation:${current.id}`,
        includedAllocationId: allocationId,
        includedUserId: acceptedUserId,
      },
      signal,
    );
    if (current.purchasedCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: current.orgId,
        userId: acceptedUserId,
        grantType: "purchased",
        idempotencyKey: `usage-pack-invitation:${current.id}:purchased`,
        amount: current.purchasedCredits,
        expiresAt: current.currentPeriodEnd,
      });
    }
    if (current.bonusCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: current.orgId,
        userId: acceptedUserId,
        grantType: "bonus",
        idempotencyKey: `usage-pack-invitation:${current.id}:bonus`,
        amount: current.bonusCredits,
        expiresAt: current.currentPeriodEnd,
      });
    }
    const at = nowDate();
    await tx
      .update(usagePackAllocations)
      .set({ status: "active", updatedAt: at })
      .where(eq(usagePackAllocations.id, allocationId));
    await tx
      .update(usagePackInvitationPurchases)
      .set({ status: "accepted", updatedAt: at })
      .where(eq(usagePackInvitationPurchases.id, current.id));
  });
}

async function loadAcceptanceCandidate(
  db: Pick<Db, "select">,
  args: UsagePackInvitationAcceptanceArgs,
): Promise<UsagePackInvitationPurchaseRow | null> {
  const purchaseLookup = args.purchaseId
    ? args.invitationId
      ? or(
          eq(usagePackInvitationPurchases.id, args.purchaseId),
          eq(usagePackInvitationPurchases.clerkInvitationId, args.invitationId),
        )
      : eq(usagePackInvitationPurchases.id, args.purchaseId)
    : eq(
        usagePackInvitationPurchases.clerkInvitationId,
        args.invitationId ?? "",
      );
  const [candidate] = await db
    .select()
    .from(usagePackInvitationPurchases)
    .where(purchaseLookup)
    .limit(1);
  if (!candidate) {
    return null;
  }
  if (
    candidate.orgId !== args.orgId ||
    (args.invitationId &&
      candidate.clerkInvitationId &&
      candidate.clerkInvitationId !== args.invitationId) ||
    (candidate.acceptedUserId && candidate.acceptedUserId !== args.userId) ||
    (args.normalizedEmail &&
      candidate.normalizedEmail !== normalizedEmail(args.normalizedEmail))
  ) {
    throw new Error("Accepted Clerk invitation does not match its purchase");
  }
  return candidate;
}

async function markLateAcceptanceForRefund(
  db: Db,
  candidate: UsagePackInvitationPurchaseRow,
  args: UsagePackInvitationAcceptanceArgs,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await lockPurchase(tx, candidate.id);
    const current = await loadPurchase(tx, candidate.id);
    if (
      !current ||
      !ACCEPTABLE_INVITATION_PURCHASE_STATUSES.has(current.status)
    ) {
      return false;
    }
    await tx
      .update(usagePackInvitationPurchases)
      .set({
        status: "refund_pending",
        failureReason: "invitation_accepted_after_period",
        acceptedUserId: args.userId,
        acceptedAt: args.acceptedAt,
        updatedAt: nowDate(),
      })
      .where(eq(usagePackInvitationPurchases.id, current.id));
    return true;
  });
}

async function recordInvitationAcceptance(
  db: Db,
  candidate: UsagePackInvitationPurchaseRow,
  args: UsagePackInvitationAcceptanceArgs,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPurchase(tx, candidate.id);
    const purchase = await loadPurchase(tx, candidate.id);
    if (!purchase || purchase.status === "accepted") {
      return;
    }
    if (ACCEPTANCE_IN_PROGRESS_STATUSES.has(purchase.status)) {
      if (purchase.acceptedUserId !== args.userId) {
        throw new Error("Invitation acceptance resolved a different user");
      }
      return;
    }
    if (!ACCEPTABLE_INVITATION_PURCHASE_STATUSES.has(purchase.status)) {
      return;
    }
    const allocationId = await ensureAcceptedInvitationSnapshot(
      tx,
      purchase,
      args.invitationId,
      args.userId,
    );
    await tx
      .update(usagePackAllocations)
      .set({
        userId: args.userId,
        invitationId: null,
        status: "paid_pending_invitation",
        updatedAt: nowDate(),
      })
      .where(eq(usagePackAllocations.id, allocationId));
    await tx
      .update(usagePackInvitationPurchases)
      .set({
        allocationId,
        ...(args.invitationId ? { clerkInvitationId: args.invitationId } : {}),
        acceptedUserId: args.userId,
        acceptedAt: args.acceptedAt,
        status: "accepted_pending_activation",
        updatedAt: nowDate(),
      })
      .where(eq(usagePackInvitationPurchases.id, purchase.id));
  });
}

export async function handleUsagePackInvitationAccepted(
  db: Db,
  args: UsagePackInvitationAcceptanceArgs,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!args.purchaseId && !args.invitationId) {
    return false;
  }
  if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
    return false;
  }
  const candidate = await loadAcceptanceCandidate(db, args);
  if (!candidate) {
    return false;
  }
  if (IGNORED_ACCEPTANCE_STATUSES.has(candidate.status)) {
    return true;
  }
  if (args.acceptedAt >= candidate.currentPeriodEnd) {
    const markedForRefund = await markLateAcceptanceForRefund(
      db,
      candidate,
      args,
    );
    if (markedForRefund) {
      await refundPurchase(db, candidate.id, false);
    }
    return true;
  }
  await recordInvitationAcceptance(db, candidate, args);
  await activateAcceptedPurchase(db, candidate.id, signal, false);
  return true;
}

async function membershipForPurchase(
  clerk: ClerkClient,
  purchase: UsagePackInvitationPurchaseRow,
): Promise<ClerkMembershipIdentity | null> {
  const memberships = await listAllOrganizationMemberships(
    clerk.organizations,
    purchase.orgId,
  );
  return (
    memberships.map(clerkMembershipIdentity).find((identity) => {
      return identity?.email === purchase.normalizedEmail;
    }) ?? null
  );
}

async function revokeAndRefundPurchase(
  db: Db,
  clerk: ClerkClient,
  purchase: UsagePackInvitationPurchaseRow,
  signal: AbortSignal | undefined,
): Promise<"accepted" | "revoked"> {
  const membership = await membershipForPurchase(clerk, purchase);
  signal?.throwIfAborted();
  if (membership) {
    await handleUsagePackInvitationAccepted(
      db,
      {
        orgId: purchase.orgId,
        ...(purchase.clerkInvitationId
          ? { invitationId: purchase.clerkInvitationId }
          : {}),
        purchaseId: purchase.id,
        userId: membership.userId,
        acceptedAt: membership.createdAt,
        normalizedEmail: membership.email,
      },
      signal,
    );
    const current = await loadPurchase(db, purchase.id);
    return current && REFUND_STATUSES.has(current.status)
      ? "revoked"
      : "accepted";
  }
  if (purchase.clerkInvitationId) {
    const pending = await listAllPendingOrganizationInvitations(
      clerk.organizations,
      purchase.orgId,
    );
    signal?.throwIfAborted();
    if (
      pending.some((invitation) => {
        return invitation.id === purchase.clerkInvitationId;
      })
    ) {
      await clerk.organizations.revokeOrganizationInvitation({
        organizationId: purchase.orgId,
        invitationId: purchase.clerkInvitationId,
      });
      signal?.throwIfAborted();
    }
  }
  const [markedForRefund] = await db
    .update(usagePackInvitationPurchases)
    .set({ status: "refund_pending", updatedAt: nowDate() })
    .where(
      and(
        eq(usagePackInvitationPurchases.id, purchase.id),
        inArray(usagePackInvitationPurchases.status, [
          "payment_succeeded",
          "creating_invitation",
          "invitation_pending",
        ]),
      ),
    )
    .returning({ id: usagePackInvitationPurchases.id });
  if (!markedForRefund) {
    const current = await loadPurchase(db, purchase.id);
    if (current && ACCEPTED_PURCHASE_STATUSES.has(current.status)) {
      return "accepted";
    }
  }
  await refundPurchase(db, purchase.id, true);
  return "revoked";
}

export async function revokeUsagePackInvitationPurchase(
  db: Db,
  clerk: ClerkClient,
  args: {
    readonly orgId: string;
    readonly invitationId: string;
  },
  signal: AbortSignal,
): Promise<RevokeUsagePackInvitationResult> {
  const [purchase] = await db
    .select()
    .from(usagePackInvitationPurchases)
    .where(
      and(
        eq(usagePackInvitationPurchases.orgId, args.orgId),
        eq(usagePackInvitationPurchases.clerkInvitationId, args.invitationId),
      ),
    )
    .limit(1);
  if (!purchase) {
    return { status: "not_found" };
  }
  if (ACCEPTED_PURCHASE_STATUSES.has(purchase.status)) {
    return { status: "accepted" };
  }
  if (purchase.status === "refunded") {
    return { status: "revoked" };
  }
  const result = await revokeAndRefundPurchase(db, clerk, purchase, signal);
  return { status: result };
}

export async function reconcileUsagePackInvitationPurchases(
  db: Db,
  clerk: ClerkClient,
  signal: AbortSignal,
): Promise<number> {
  if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
    return 0;
  }
  signal.throwIfAborted();
  const at = nowDate();
  await db
    .update(usagePackInvitationPurchases)
    .set({
      status: "failed",
      failureReason: "checkout_expired",
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackInvitationPurchases.status, "checkout_pending"),
        lte(usagePackInvitationPurchases.stripeCheckoutExpiresAt, at),
      ),
    );
  const candidates = await db
    .select()
    .from(usagePackInvitationPurchases)
    .where(
      inArray(usagePackInvitationPurchases.status, [
        "payment_succeeded",
        "creating_invitation",
        "invitation_pending",
        "accepted_pending_activation",
        "activating",
        "refund_pending",
        "refunding",
      ]),
    );
  signal.throwIfAborted();
  let reconciled = 0;
  for (const purchase of candidates) {
    switch (purchase.status) {
      case "payment_succeeded":
      case "creating_invitation": {
        await ensurePaidInvitationCreated(db, clerk, purchase.id, true);
        reconciled += 1;
        break;
      }
      case "invitation_pending": {
        if (purchase.currentPeriodEnd <= at) {
          await revokeAndRefundPurchase(db, clerk, purchase, signal);
          reconciled += 1;
          break;
        }
        const membership = await membershipForPurchase(clerk, purchase);
        signal.throwIfAborted();
        if (membership && purchase.clerkInvitationId) {
          await handleUsagePackInvitationAccepted(
            db,
            {
              orgId: purchase.orgId,
              invitationId: purchase.clerkInvitationId,
              userId: membership.userId,
              acceptedAt: membership.createdAt,
              normalizedEmail: membership.email,
            },
            signal,
          );
          reconciled += 1;
        }
        break;
      }
      case "accepted_pending_activation":
      case "activating": {
        await activateAcceptedPurchase(db, purchase.id, signal, true);
        reconciled += 1;
        break;
      }
      case "refund_pending":
      case "refunding": {
        await refundPurchase(db, purchase.id, true);
        reconciled += 1;
        break;
      }
      case "checkout_pending":
      case "accepted":
      case "refunded":
      case "failed": {
        break;
      }
    }
    signal.throwIfAborted();
  }
  return reconciled;
}
