import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testBillingStatusStateContract,
  type TestBillingStatusStateActionBody,
} from "@vm0/api-contracts/contracts/test-billing-status-state";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgConcurrencyEntitlements } from "@vm0/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@vm0/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq, sql } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testBillingStatusStateContract.action);

type BillingStatusAction<
  TAction extends TestBillingStatusStateActionBody["action"],
> = Extract<TestBillingStatusStateActionBody, { action: TAction }>;

type OrgMetadataInsert = typeof orgMetadata.$inferInsert;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

function valueOrDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function dateValueOrDefault(
  value: string | null | undefined,
  fallback: string | null | undefined,
): Date | null {
  const selected = valueOrDefault(value, fallback);
  return selected ? new Date(selected) : null;
}

function orgMetadataSeedValues(
  orgId: string,
  values: BillingStatusAction<"seed-org">,
): OrgMetadataInsert {
  const sub = values.subscription;
  return {
    orgId,
    credits: values.credits ?? 0,
    onboardingPaymentPending: Boolean(values.onboarding_payment_pending),
    tier: values.tier ?? sub?.tier ?? "free",
    stripeCustomerId: valueOrDefault(
      values.stripe_customer_id,
      sub?.stripe_customer_id ?? null,
    ),
    stripeSubscriptionId: valueOrDefault(
      values.stripe_subscription_id,
      sub?.stripe_subscription_id ?? null,
    ),
    subscriptionStatus: valueOrDefault(
      values.subscription_status,
      sub?.status ?? null,
    ),
    currentPeriodEnd: dateValueOrDefault(
      values.current_period_end,
      sub?.current_period_end,
    ),
    cancelAtPeriodEnd:
      values.cancel_at_period_end ?? sub?.cancel_at_period_end ?? false,
    pendingSubscriptionScheduleId: valueOrDefault(
      values.pending_subscription_schedule_id,
      sub?.pending_subscription_schedule_id ?? null,
    ),
    pendingSubscriptionTargetTier: valueOrDefault(
      values.pending_subscription_target_tier,
      sub?.pending_subscription_target_tier ?? null,
    ),
    pendingSubscriptionChangeAt: dateValueOrDefault(
      values.pending_subscription_change_at,
      sub?.pending_subscription_change_at,
    ),
  };
}

async function grantExtraCredits(
  db: Db,
  orgId: string,
  credits: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!credits) {
    return;
  }

  await db
    .update(orgMetadata)
    .set({
      credits: sql`${orgMetadata.credits} + ${credits}`,
    })
    .where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
}

async function insertExpiresRecords(
  db: Db,
  orgId: string,
  records: BillingStatusAction<"seed-org">["expires_records"],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const expiresRecordIds: string[] = [];
  for (const record of records ?? []) {
    const [row] = await db
      .insert(creditExpiresRecord)
      .values({
        orgId,
        source: record.source,
        amount: record.amount,
        remaining: record.remaining ?? record.amount,
        expiresAt: new Date(record.expires_at),
        stripeInvoiceId: record.stripe_invoice_id ?? `inv_${randomUUID()}`,
      })
      .returning({ id: creditExpiresRecord.id });
    signal.throwIfAborted();
    if (row) {
      expiresRecordIds.push(row.id);
    }
  }
  return expiresRecordIds;
}

async function insertConcurrencyEntitlements(
  db: Db,
  orgId: string,
  entitlements: BillingStatusAction<"seed-org">["concurrency_entitlements"],
  signal: AbortSignal,
): Promise<void> {
  const subscriptions = new Map<
    string,
    {
      readonly stripePriceId: string;
      readonly subscriptionStatus: string;
      readonly cancelAtPeriodEnd: boolean;
      slots: number;
      currentPeriodEnd: Date;
    }
  >();
  const currentTime = nowDate();

  for (const entitlement of entitlements ?? []) {
    const startsAt = new Date(entitlement.starts_at);
    const expiresAt = new Date(entitlement.expires_at);
    const stripeSubscriptionId =
      entitlement.stripe_subscription_id ?? `sub_${randomUUID()}`;
    const stripePriceId =
      entitlement.stripe_price_id ?? `price_${randomUUID()}`;

    await db.insert(orgConcurrencyEntitlements).values({
      orgId,
      slots: entitlement.slots,
      startsAt,
      expiresAt,
      stripeSubscriptionId,
      stripeInvoiceId: entitlement.stripe_invoice_id ?? `inv_${randomUUID()}`,
      stripeInvoiceLineId:
        entitlement.stripe_invoice_line_id ?? `il_${randomUUID()}`,
      stripePriceId,
    });
    signal.throwIfAborted();

    if (startsAt <= currentTime && expiresAt > currentTime) {
      const existing = subscriptions.get(stripeSubscriptionId);
      if (existing) {
        existing.slots += entitlement.slots;
        if (expiresAt > existing.currentPeriodEnd) {
          existing.currentPeriodEnd = expiresAt;
        }
      } else {
        subscriptions.set(stripeSubscriptionId, {
          stripePriceId,
          subscriptionStatus: entitlement.subscription_status ?? "active",
          cancelAtPeriodEnd: entitlement.cancel_at_period_end ?? false,
          slots: entitlement.slots,
          currentPeriodEnd: expiresAt,
        });
      }
    }
  }

  for (const [stripeSubscriptionId, subscription] of subscriptions) {
    await db.insert(orgConcurrencySubscriptions).values({
      orgId,
      stripeSubscriptionId,
      stripePriceId: subscription.stripePriceId,
      slots: subscription.slots,
      subscriptionStatus: subscription.subscriptionStatus,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    });
    signal.throwIfAborted();
  }
}

async function seedOrgForAction(
  db: Db,
  body: BillingStatusAction<"seed-org">,
  signal: AbortSignal,
) {
  const orgId = body.org_id ?? `org_${randomUUID()}`;
  const userId = body.user_id ?? `user_${randomUUID()}`;
  const values = orgMetadataSeedValues(orgId, body);

  await db
    .insert(orgMetadata)
    .values(values)
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        credits: values.credits,
        onboardingPaymentPending: values.onboardingPaymentPending,
        tier: values.tier,
        stripeCustomerId: values.stripeCustomerId,
        stripeSubscriptionId: values.stripeSubscriptionId,
        subscriptionStatus: values.subscriptionStatus,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAtPeriodEnd: values.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId: values.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier: values.pendingSubscriptionTargetTier,
        pendingSubscriptionChangeAt: values.pendingSubscriptionChangeAt,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();

  await grantExtraCredits(db, orgId, body.extra_granted_credits, signal);
  const expiresRecordIds = await insertExpiresRecords(
    db,
    orgId,
    body.expires_records,
    signal,
  );
  await insertConcurrencyEntitlements(
    db,
    orgId,
    body.concurrency_entitlements,
    signal,
  );

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      fixture: {
        org_id: orgId,
        user_id: userId,
        expires_record_ids: expiresRecordIds,
      },
    },
  };
}

async function deleteOrgForAction(
  db: Db,
  body: BillingStatusAction<"delete-org">,
  signal: AbortSignal,
) {
  const orgId = body.fixture.org_id;

  await db
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(orgConcurrencyEntitlements)
    .where(eq(orgConcurrencyEntitlements.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(orgConcurrencySubscriptions)
    .where(eq(orgConcurrencySubscriptions.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();

  return actionOk();
}

const mutateBillingStatusState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;

    switch (body.action) {
      case "seed-org": {
        return await seedOrgForAction(db, body, signal);
      }
      case "delete-org": {
        return await deleteOrgForAction(db, body, signal);
      }
    }
  },
);

export const testBillingStatusStateRoutes: readonly RouteEntry[] = [
  {
    route: testBillingStatusStateContract.action,
    handler: mutateBillingStatusState$,
  },
];
