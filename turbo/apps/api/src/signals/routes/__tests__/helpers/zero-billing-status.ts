import { command } from "ccstate";
import type {
  TestBillingStatusStateActionBody,
  TestBillingStatusStateActionResponse,
  TestBillingStatusStateFixture,
} from "@vm0/api-contracts/contracts/test-billing-status-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testBillingStatusStateRoutes } from "../../test-billing-status-state";

const BILLING_STATUS_STATE_ROUTE = "/api/test/billing-status-state";

export interface BillingStatusFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly expiresRecordIds: readonly string[];
}

interface SubscriptionSeed {
  readonly tier: string;
  readonly status: string;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd?: boolean;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly pendingSubscriptionScheduleId?: string;
  readonly pendingSubscriptionTargetTier?: string;
  readonly pendingSubscriptionChangeAt?: Date;
}

interface ExpiresRecordSeed {
  readonly source: string;
  readonly amount: number;
  readonly remaining?: number;
  readonly expiresAt: Date;
  readonly stripeInvoiceId?: string;
}

interface ConcurrencyEntitlementSeed {
  readonly slots: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly subscriptionStatus?: string;
  readonly cancelAtPeriodEnd?: boolean;
  readonly stripeSubscriptionId?: string;
  readonly stripeInvoiceId?: string;
  readonly stripeInvoiceLineId?: string;
  readonly stripePriceId?: string;
}

interface BillingStatusSeedValues {
  readonly credits?: number;
  readonly onboardingPaymentPending?: boolean;
  readonly subscription?: SubscriptionSeed;
  readonly expiresRecords?: readonly ExpiresRecordSeed[];
  readonly concurrencyEntitlements?: readonly ConcurrencyEntitlementSeed[];
  readonly extraGrantedCredits?: number;
}

function requestBillingStatusState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testBillingStatusStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestBillingStatusStateActionBody,
): Promise<TestBillingStatusStateActionResponse> {
  const response = await requestBillingStatusState(
    signal,
    `${BILLING_STATUS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  expectOk(response, `billing status state action ${body.action}`);
  signal.throwIfAborted();
  const result = await readJson<TestBillingStatusStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

function fixtureFromWire(
  fixture: TestBillingStatusStateFixture,
): BillingStatusFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
    expiresRecordIds: fixture.expires_record_ids,
  };
}

function fixtureToWire(
  fixture: BillingStatusFixture,
): TestBillingStatusStateFixture {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
    expires_record_ids: [...fixture.expiresRecordIds],
  };
}

function seedValuesToWire(
  values: BillingStatusSeedValues,
): TestBillingStatusStateActionBody {
  return {
    action: "seed-org",
    credits: values.credits,
    onboarding_payment_pending: values.onboardingPaymentPending,
    subscription: values.subscription
      ? {
          tier: values.subscription.tier,
          status: values.subscription.status,
          current_period_end:
            values.subscription.currentPeriodEnd.toISOString(),
          cancel_at_period_end: values.subscription.cancelAtPeriodEnd,
          stripe_customer_id: values.subscription.stripeCustomerId,
          stripe_subscription_id: values.subscription.stripeSubscriptionId,
          pending_subscription_schedule_id:
            values.subscription.pendingSubscriptionScheduleId,
          pending_subscription_target_tier:
            values.subscription.pendingSubscriptionTargetTier,
          pending_subscription_change_at:
            values.subscription.pendingSubscriptionChangeAt?.toISOString(),
        }
      : undefined,
    expires_records: values.expiresRecords?.map((record) => {
      return {
        source: record.source,
        amount: record.amount,
        remaining: record.remaining,
        expires_at: record.expiresAt.toISOString(),
        stripe_invoice_id: record.stripeInvoiceId,
      };
    }),
    concurrency_entitlements: values.concurrencyEntitlements?.map(
      (entitlement) => {
        return {
          slots: entitlement.slots,
          starts_at: entitlement.startsAt.toISOString(),
          expires_at: entitlement.expiresAt.toISOString(),
          subscription_status: entitlement.subscriptionStatus,
          cancel_at_period_end: entitlement.cancelAtPeriodEnd,
          stripe_subscription_id: entitlement.stripeSubscriptionId,
          stripe_invoice_id: entitlement.stripeInvoiceId,
          stripe_invoice_line_id: entitlement.stripeInvoiceLineId,
          stripe_price_id: entitlement.stripePriceId,
        };
      },
    ),
    extra_granted_credits: values.extraGrantedCredits,
  };
}

export const seedBillingStatusOrg$ = command(
  async (
    _,
    values: BillingStatusSeedValues,
    signal: AbortSignal,
  ): Promise<BillingStatusFixture> => {
    const response = await postAction(signal, seedValuesToWire(values));
    if (!response.fixture) {
      throw new Error("seedBillingStatusOrg$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteBillingStatusOrg$ = command(
  async (
    _,
    fixture: BillingStatusFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-org",
      fixture: fixtureToWire(fixture),
    });
  },
);
