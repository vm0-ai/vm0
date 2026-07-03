import { command } from "ccstate";
import type {
  TestBillingStatusStateActionBody,
  TestBillingStatusStateActionResponse,
  TestBillingStatusStateFixture,
} from "@vm0/api-contracts/contracts/test-billing-status-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testBillingStatusStateRoutes } from "../../test-billing-status-state";

const BILLING_STATUS_STATE_ROUTE = "/api/test/billing-status-state";

export interface InvoicesOrgFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly stripeCustomerId: string | null;
}

interface InvoicesSeedValues {
  readonly stripeCustomerId?: string | null;
  readonly stripeSubscriptionId?: string | null;
  readonly subscriptionStatus?: string | null;
  readonly tier?: string;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly pendingSubscriptionScheduleId?: string | null;
  readonly pendingSubscriptionTargetTier?: string | null;
  readonly pendingSubscriptionChangeAt?: Date | null;
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
  stripeCustomerId: string | null,
): InvoicesOrgFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
    stripeCustomerId,
  };
}

export const seedInvoicesOrg$ = command(
  async (
    _,
    values: InvoicesSeedValues,
    signal: AbortSignal,
  ): Promise<InvoicesOrgFixture> => {
    const stripeCustomerId = values.stripeCustomerId ?? null;
    const response = await postAction(signal, {
      action: "seed-org",
      tier: values.tier,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: values.stripeSubscriptionId ?? null,
      subscription_status: values.subscriptionStatus ?? null,
      current_period_end:
        values.currentPeriodEnd === undefined
          ? undefined
          : (values.currentPeriodEnd?.toISOString() ?? null),
      cancel_at_period_end: values.cancelAtPeriodEnd,
      pending_subscription_schedule_id:
        values.pendingSubscriptionScheduleId ?? null,
      pending_subscription_target_tier:
        values.pendingSubscriptionTargetTier ?? null,
      pending_subscription_change_at:
        values.pendingSubscriptionChangeAt === undefined
          ? undefined
          : (values.pendingSubscriptionChangeAt?.toISOString() ?? null),
    });
    if (!response.fixture) {
      throw new Error("seedInvoicesOrg$: response missing fixture");
    }
    return fixtureFromWire(response.fixture, stripeCustomerId);
  },
);

export const deleteInvoicesOrg$ = command(
  async (
    _,
    fixture: InvoicesOrgFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-org",
      fixture: {
        org_id: fixture.orgId,
        user_id: fixture.userId,
        expires_record_ids: [],
      },
    });
  },
);
