import { randomUUID } from "node:crypto";

import { zeroOrgDeleteContract } from "@vm0/api-contracts/contracts/zero-org";
import type StripeSDK from "stripe";
import { afterEach, expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  mockStripeClient,
  type StripeCreditNote,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripeSubscription,
} from "../../external/stripe-client";
import { zeroOrgDeleteRoutes } from "../zero-org-delete";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  postConcurrencyEntitlementsInvoicePaid,
  postOneTimePurchaseCompleted,
  postSubscriptionInvoicePaid,
  postUsageAllowanceInvoicePaid,
  TEST_PRICE_CONCURRENCY,
  type BillingWebhookFixture,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface OrgDeleteBillingFixture extends BillingWebhookFixture {
  readonly customerId: string;
}

function createOrgDeleteBillingFixture(): OrgDeleteBillingFixture {
  return {
    ...createBillingWebhookFixture(),
    customerId: generatedStripeCustomerId(),
  };
}

async function seedPlanSubscription(
  fixture: OrgDeleteBillingFixture,
  subscriptionId: string,
  periodEndTimestamp = 1_900_000_000,
): Promise<void> {
  await postSubscriptionInvoicePaid(context.signal, {
    ...fixture,
    tier: "pro",
    subscriptionId,
    currentPeriodEnd: new Date(periodEndTimestamp * 1000),
  });
}

afterEach(() => {
  clearMockNow();
});

function subscription(
  id: string,
  customerId: string,
  args?: {
    readonly status?: string;
    readonly metadata?: Record<string, string>;
  },
): StripeSubscription {
  return {
    id,
    customer: customerId,
    status: args?.status ?? "active",
    metadata: args?.metadata ?? {},
    cancel_at_period_end: false,
    latest_invoice: null,
    items: { data: [] },
  };
}

function subscriptionLine(
  amount: number,
  start: number,
  end: number,
  exclusiveTax = 0,
): StripeInvoiceLine {
  return {
    id: `il_${randomUUID().slice(0, 8)}`,
    amount,
    taxes:
      exclusiveTax > 0
        ? [{ amount: exclusiveTax, tax_behavior: "exclusive" }]
        : [],
    period: { start, end },
    parent: {
      type: "subscription_item_details",
      subscription_item_details: { proration: false },
    },
  };
}

function oneTimeLine(
  amount: number,
  start: number,
  end: number,
): StripeInvoiceLine {
  return {
    id: `il_once_${randomUUID().slice(0, 8)}`,
    amount,
    period: { start, end },
    parent: {
      type: "invoice_item_details",
      invoice_item_details: { proration: false },
    },
  };
}

function paidInvoice(
  id: string,
  customerId: string,
  subscriptionId: string,
  lines: readonly StripeInvoiceLine[],
): StripeInvoice {
  return {
    id,
    customer: customerId,
    metadata: {},
    amount_due: lines.reduce((total, line) => {
      return total + line.amount;
    }, 0),
    currency: "usd",
    status: "paid",
    paid: true,
    lines: { data: lines },
    parent: {
      subscription_details: {
        subscription: subscriptionId,
        metadata: {},
      },
    },
  };
}

function creditNote(
  id: string,
  amount: number,
  metadata?: Record<string, string>,
): StripeCreditNote {
  return {
    id,
    status: "issued",
    metadata,
    pre_payment_amount: 0,
    post_payment_amount: amount,
    refunds: [
      {
        amount_refunded: amount,
        refund: { id: `re_${id}`, status: "succeeded" },
      },
    ],
  };
}

function mockOrgDeletion(fixture: OrgDeleteBillingFixture): void {
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: fixture.orgId,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [] },
  );
  context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue({});
  context.mocks.stripe.subscriptions.update.mockResolvedValue({});
  context.mocks.stripe.subscriptions.cancel.mockResolvedValue({});
  context.mocks.stripe.creditNotes.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
}

async function requestOrgDeletion() {
  const client = setupApp({ context, routes: zeroOrgDeleteRoutes })(
    zeroOrgDeleteContract,
  );
  return await client.delete({
    headers: { authorization: "Bearer clerk-session" },
    body: { confirm: "confirm" },
  });
}

test("immediately cancels and proportionally refunds every org subscription source", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 800;
  const periodEnd = deletionTimestamp + 200;
  const ids = {
    plan: "sub_delete_plan",
    usagePack: "sub_delete_usage_pack",
    allowance: "sub_delete_allowance",
    concurrency: "sub_delete_concurrency",
  };
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, ids.plan, periodEnd);
  await postUsageAllowanceInvoicePaid(context.signal, {
    ...fixture,
    subscriptionId: ids.allowance,
    shortWindowSeconds: 300,
    shortWindowUnits: 1000,
    weeklyWindowSeconds: 604_800,
    weeklyWindowUnits: 10_000,
    effectiveAt: new Date(periodStart * 1000),
    expiresAt: new Date(periodEnd * 1000),
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: ids.concurrency,
    customer: fixture.customerId,
    status: "active",
    metadata: { purpose: "concurrency_subscription" },
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: TEST_PRICE_CONCURRENCY },
          quantity: 1,
          current_period_end: periodEnd,
        },
      ],
    },
  });
  await postConcurrencyEntitlementsInvoicePaid(context.signal, {
    ...fixture,
    subscriptionId: ids.concurrency,
    lines: [
      {
        slots: 1,
        startsAt: new Date(periodStart * 1000),
        expiresAt: new Date(periodEnd * 1000),
      },
    ],
    subscriptionStatus: "active",
  });
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);

  context.mocks.stripe.subscriptions.list
    .mockResolvedValueOnce({
      data: [
        subscription(ids.plan, fixture.customerId),
        subscription(ids.usagePack, fixture.customerId),
      ],
      has_more: true,
    })
    .mockResolvedValueOnce({
      data: [subscription(ids.allowance, fixture.customerId)],
      has_more: false,
    });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
    subscription(ids.concurrency, fixture.customerId),
  );
  for (const [index, subscriptionId] of Object.values(ids).entries()) {
    context.mocks.stripe.invoices.list.mockResolvedValueOnce({
      data: [
        paidInvoice(`in_delete_${index}`, fixture.customerId, subscriptionId, [
          subscriptionLine(1000, periodStart, periodEnd),
        ]),
      ],
      has_more: false,
    });
  }
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_delete", 200),
  );
  context.mocks.stripe.creditNotes.create.mockResolvedValue(
    creditNote("cn_delete", 200),
  );

  const response = await accept(requestOrgDeletion(), [200]);

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(context.mocks.stripe.subscriptions.list).toHaveBeenNthCalledWith(2, {
    customer: fixture.customerId,
    status: "all",
    limit: 100,
    starting_after: ids.usagePack,
  });
  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(4);
  for (const subscriptionId of Object.values(ids)) {
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      subscriptionId,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: `org-delete:${fixture.orgId}:${subscriptionId}:cancel`,
      },
    );
  }
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(4);
  expect(
    context.mocks.stripe.creditNotes.create.mock.calls.map((call) => {
      return call[0];
    }),
  ).toStrictEqual(
    expect.arrayContaining(
      Object.values(ids).map((subscriptionId, index) => {
        return expect.objectContaining({
          invoice: `in_delete_${index}`,
          amount: 200,
          refund_amount: 200,
          metadata: {
            purpose: "org_deletion_prorated_refund",
            orgId: fixture.orgId,
            subscriptionId,
            deletionAt: String(deletionTimestamp),
          },
        });
      }),
    ),
  );
  const lastRefundCall =
    context.mocks.stripe.creditNotes.create.mock.invocationCallOrder.at(-1);
  const deleteCall =
    context.mocks.clerk.organizations.deleteOrganization.mock
      .invocationCallOrder[0];
  if (lastRefundCall === undefined || deleteCall === undefined) {
    throw new Error("Expected refund and organization deletion calls");
  }
  expect(lastRefundCall).toBeLessThan(deleteCall);
});

test("deletes an org without Stripe calls when it has no billing references", async () => {
  const fixture = createOrgDeleteBillingFixture();
  mockOrgDeletion(fixture);

  const response = await accept(requestOrgDeletion(), [200]);

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(context.mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
  expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("does not refund non-subscription purchases for an org customer", async () => {
  const fixture = createOrgDeleteBillingFixture();
  await postOneTimePurchaseCompleted(context.signal, {
    orgId: fixture.orgId,
    credits: 100_000,
  });
  mockOrgDeletion(fixture);

  const response = await accept(requestOrgDeletion(), [200]);

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(context.mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
  expect(context.mocks.stripe.invoices.list).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("cancels trials and unpaid subscriptions without inventing a refund", async () => {
  const trialId = "sub_delete_trial";
  const unpaidId = "sub_delete_unpaid";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, trialId);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [
      subscription(trialId, fixture.customerId, { status: "trialing" }),
      subscription(unpaidId, fixture.customerId, { status: "unpaid" }),
    ],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [],
    has_more: false,
  });

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
  expect(context.mocks.stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("nets upgrade credits and excludes one-time invoice items from proration", async () => {
  const deletionTimestamp = 1_800_000_000;
  const originalStart = deletionTimestamp - 600;
  const periodEnd = deletionTimestamp + 400;
  const upgradeStart = deletionTimestamp - 400;
  const subscriptionId = "sub_delete_upgraded";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_original", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, originalStart, periodEnd, 100),
        oneTimeLine(2000, originalStart, periodEnd),
      ]),
      paidInvoice("in_delete_upgrade", fixture.customerId, subscriptionId, [
        subscriptionLine(-600, upgradeStart, periodEnd),
        subscriptionLine(1200, upgradeStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview
    .mockResolvedValueOnce(creditNote("preview_original", 440))
    .mockResolvedValueOnce(creditNote("preview_upgrade", 300));
  context.mocks.stripe.creditNotes.create
    .mockResolvedValueOnce(creditNote("cn_original", 440))
    .mockResolvedValueOnce(creditNote("cn_upgrade", 300));

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ invoice: "in_delete_original", amount: 440 }),
  );
  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ invoice: "in_delete_upgrade", amount: 300 }),
  );
});

test("reuses a prior deletion marker and issued credit note on retry", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 600;
  const periodEnd = deletionTimestamp + 400;
  const subscriptionId = "sub_delete_retry";
  const historicalSubscriptionId = "sub_delete_historical";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockOrgDeletion(fixture);
  const metadata = {
    purpose: "org_deletion_prorated_refund",
    orgId: fixture.orgId,
    subscriptionId,
    deletionAt: String(deletionTimestamp),
  };
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [
      subscription(historicalSubscriptionId, fixture.customerId, {
        status: "canceled",
      }),
      subscription(subscriptionId, fixture.customerId, {
        status: "canceled",
        metadata: {
          vm0_org_delete_org_id: fixture.orgId,
          vm0_org_delete_at: String(deletionTimestamp),
        },
      }),
    ],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_retry", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.list.mockResolvedValue({
    data: [creditNote("cn_delete_retry", 400, metadata)],
    has_more: false,
  });

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(context.mocks.stripe.invoices.list).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.invoices.list).toHaveBeenCalledWith({
    subscription: subscriptionId,
    status: "paid",
    limit: 100,
  });
  expect(context.mocks.stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).toHaveBeenCalledWith(fixture.orgId);
});

test("does not delete the org when its proportional refund fails", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_refund_failure";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_failure", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_failure", 500),
  );
  context.mocks.stripe.creditNotes.create.mockRejectedValue(
    new Error("Stripe refund unavailable"),
  );

  const response = await requestOrgDeletion();

  expect(response.status).toBe(500);
  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).not.toHaveBeenCalled();
});

test("retries refunds on redelivery before cleaning a Clerk-deleted org", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_clerk_webhook";
  const fixture = createOrgDeleteBillingFixture();
  const actor: ApiTestUser = {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: "org-delete-clerk@example.test",
  };
  mockNow(deletionTimestamp * 1000);
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

  context.mocks.stripe.subscriptions.list
    .mockResolvedValueOnce({
      data: [subscription(subscriptionId, fixture.customerId)],
      has_more: false,
    })
    .mockResolvedValueOnce({
      data: [
        subscription(subscriptionId, fixture.customerId, {
          status: "canceled",
          metadata: {
            vm0_org_delete_org_id: fixture.orgId,
            vm0_org_delete_at: String(deletionTimestamp),
          },
        }),
      ],
      has_more: false,
    });
  context.mocks.stripe.subscriptions.update.mockResolvedValue({});
  context.mocks.stripe.subscriptions.cancel.mockResolvedValue({});
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_clerk", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_delete_clerk", 500),
  );
  context.mocks.stripe.creditNotes.create
    .mockRejectedValueOnce(new Error("Stripe refund unavailable"))
    .mockResolvedValueOnce(creditNote("cn_delete_clerk", 500));

  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  const deliverOrgDeleted = async (): Promise<void> => {
    webhooks.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: fixture.orgId },
    });
    const response = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");
    await flushWaitUntilForTest();
  };

  await deliverOrgDeleted();

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledOnce();
  expect(
    (await createBillingMediaApi(context).readBillingStatus(actor))
      .hasSubscription,
  ).toBeTruthy();

  await deliverOrgDeleted();

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(2);
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      invoice: "in_delete_clerk",
      amount: 500,
      refund_amount: 500,
    }),
    expect.objectContaining({
      idempotencyKey: `org-delete-refund:${fixture.orgId}:${subscriptionId}:in_delete_clerk:${deletionTimestamp}`,
    }),
  );
  expect(
    (await createBillingMediaApi(context).readBillingStatus(actor))
      .hasSubscription,
  ).toBeFalsy();
});
