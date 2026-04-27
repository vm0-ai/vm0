import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import {
  findCreditExpiresRecordByStripeInvoiceId,
  getOrgCredits,
} from "../../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../../env";

// Hoist Stripe mocks — the service reads through `getStripe()` which calls
// `new Stripe(...)` lazily, so this mock covers any call site.
const stripeMocks = vi.hoisted(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    checkoutSessionsCreate: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: { retrieve: stripeMocks.subscriptionsRetrieve },
        checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
        invoices: { list: vi.fn() },
        customers: { create: vi.fn() },
        billingPortal: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
        products: { retrieve: vi.fn() },
        prices: { list: vi.fn() },
      };
    },
  };
});

/* eslint-disable web/no-direct-db-in-tests -- Webhook handler is triggered by Stripe, not an HTTP route the test can POST to */
// oxlint-disable-next-line import/first -- import must follow vi.mock so stripe is stubbed before billing-service evaluates getStripe.
import { handleCheckoutCompleted } from "../billing-service";
/* eslint-enable web/no-direct-db-in-tests */

const context = testContext();

const KNOWN_CAMPAIGN = "ZERO100";
const KNOWN_CREDITS = 100_000;
const CAMPAIGN_ENV = JSON.stringify({
  [KNOWN_CAMPAIGN]: {
    priceId: "price_test_campaign",
    couponId: "ZERO100",
  },
});

interface CheckoutInput {
  id: string;
  subscription: string | { id: string } | null;
  customer: string | { id: string } | null;
  metadata: Record<string, string> | null;
  payment_status?: string | null;
}

function oneTimeSession(
  sessionId: string,
  metadata: Record<string, string>,
): CheckoutInput {
  return {
    id: sessionId,
    subscription: null,
    customer: "cus_one_time",
    metadata,
    payment_status: "paid",
  };
}

describe("handleCheckoutCompleted — one-time purchase dispatch", () => {
  let user: UserContext;
  let baseCredits: number;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("ZERO_ONE_TIME_CAMPAIGN", CAMPAIGN_ENV);
    reloadEnv();

    stripeMocks.subscriptionsRetrieve.mockReset();
    stripeMocks.checkoutSessionsCreate.mockReset();

    baseCredits = (await getOrgCredits(user.orgId)) ?? 0;
  });

  it("grants credits from campaign registry when campaignKey is whitelisted", async () => {
    const sessionId = `cs_test_${user.userId}_happy`;
    await handleCheckoutCompleted(
      oneTimeSession(sessionId, {
        purpose: "one_time_purchase",
        orgId: user.orgId,
        campaignKey: KNOWN_CAMPAIGN,
      }),
    );

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits + KNOWN_CREDITS);

    const row = await findCreditExpiresRecordByStripeInvoiceId(
      user.orgId,
      sessionId,
    );
    expect(row).toBeDefined();
    expect(row?.amount).toBe(KNOWN_CREDITS);
    expect(row?.remaining).toBe(KNOWN_CREDITS);
    expect(row?.source).toBe("one_time_purchase");
    // Expiry window from CAMPAIGN_POLICY is 30 days
    const now = Date.now();
    const expiresMs = row!.expiresAt.getTime() - now;
    expect(expiresMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(expiresMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
  });

  it("does not grant credits until a one-time checkout is actually paid", async () => {
    const sessionId = `cs_test_${user.userId}_awaiting_payment`;
    await handleCheckoutCompleted(
      oneTimeSession(sessionId, {
        purpose: "one_time_purchase",
        orgId: user.orgId,
        campaignKey: KNOWN_CAMPAIGN,
      }),
    );

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits + KNOWN_CREDITS);

    const unpaidSessionId = `cs_test_${user.userId}_unpaid`;
    await handleCheckoutCompleted({
      ...oneTimeSession(unpaidSessionId, {
        purpose: "one_time_purchase",
        orgId: user.orgId,
        campaignKey: KNOWN_CAMPAIGN,
      }),
      payment_status: "unpaid",
    });

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits + KNOWN_CREDITS);

    const unpaidRow = await findCreditExpiresRecordByStripeInvoiceId(
      user.orgId,
      unpaidSessionId,
    );
    expect(unpaidRow).toBeUndefined();
  });

  it("is idempotent when the same session id is delivered twice", async () => {
    const sessionId = `cs_test_${user.userId}_idemp`;
    const payload = oneTimeSession(sessionId, {
      purpose: "one_time_purchase",
      orgId: user.orgId,
      campaignKey: KNOWN_CAMPAIGN,
    });

    await handleCheckoutCompleted(payload);
    await handleCheckoutCompleted(payload);

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits + KNOWN_CREDITS);
  });

  it("skips unknown campaignKey without granting credits (defense-in-depth)", async () => {
    const sessionId = `cs_test_${user.userId}_unknown`;
    await handleCheckoutCompleted(
      oneTimeSession(sessionId, {
        purpose: "one_time_purchase",
        orgId: user.orgId,
        campaignKey: "NOT_LISTED",
      }),
    );

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits);

    const row = await findCreditExpiresRecordByStripeInvoiceId(
      user.orgId,
      sessionId,
    );
    expect(row).toBeUndefined();
  });

  it("skips when one_time_purchase metadata is missing orgId", async () => {
    const sessionId = `cs_test_${user.userId}_missing`;
    await handleCheckoutCompleted(
      oneTimeSession(sessionId, {
        purpose: "one_time_purchase",
        campaignKey: KNOWN_CAMPAIGN,
      }),
    );

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits);
  });

  it("does not dispatch to one-time handler when purpose is absent (subscription path)", async () => {
    // No purpose metadata → falls through to subscription path, which needs a
    // subscription id. We pass null so the existing code logs and returns
    // without granting credits — the important thing is the new dispatch
    // branch didn't short-circuit it.
    const sessionId = `cs_test_${user.userId}_sub`;
    await handleCheckoutCompleted({
      id: sessionId,
      subscription: null,
      customer: "cus_test",
      metadata: null,
    });

    expect(await getOrgCredits(user.orgId)).toBe(baseCredits);
    const row = await findCreditExpiresRecordByStripeInvoiceId(
      user.orgId,
      sessionId,
    );
    expect(row).toBeUndefined();
  });
});
