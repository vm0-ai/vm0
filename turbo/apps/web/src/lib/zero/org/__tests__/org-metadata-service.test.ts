import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import type { StripeMockFns } from "../../../../__tests__/stripe-mock";
import {
  createTestOrg,
  updateOrgTier,
  updateOrgStripeFields,
  setOrgCredits,
} from "../../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../../env";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { getOrgMetadata, getOrgBillingPeriod } from "../org-metadata-service";

// Mock stripe module (external dependency)
const stripeMocks = vi.hoisted<StripeMockFns>(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    subscriptionsUpdate: vi.fn(),
    subscriptionsCancel: vi.fn(),
    invoicesRetrieve: vi.fn(),
    invoicesList: vi.fn(),
    customersCreate: vi.fn(),
    checkoutSessionsCreate: vi.fn(),
    billingPortalSessionsCreate: vi.fn(),
    constructEvent: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: {
          retrieve: stripeMocks.subscriptionsRetrieve,
          update: stripeMocks.subscriptionsUpdate,
          cancel: stripeMocks.subscriptionsCancel,
        },
        invoices: {
          retrieve: stripeMocks.invoicesRetrieve,
          list: stripeMocks.invoicesList,
        },
        customers: { create: stripeMocks.customersCreate },
        checkout: { sessions: { create: stripeMocks.checkoutSessionsCreate } },
        billingPortal: {
          sessions: { create: stripeMocks.billingPortalSessionsCreate },
        },
        webhooks: { constructEvent: stripeMocks.constructEvent },
      };
    },
  };
});

const context = testContext();

describe("getOrgMetadata", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns tier and credits from org_metadata when row exists", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    await updateOrgTier(orgId, "pro");
    await setOrgCredits(orgId, 100_000);

    const result = await getOrgMetadata(orgId);

    expect(result).toEqual({
      orgId,
      tier: "pro",
      credits: 100_000,
      defaultAgentId: null,
    });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("throws notFound when no row exists", async () => {
    const orgId = uniqueId("org-nonexistent");

    await expect(getOrgMetadata(orgId)).rejects.toThrow(
      `Organization ${orgId} not found`,
    );

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("returns 0 credits for new org without a starter grant", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // createTestOrg inserts the row directly without going through
    // ensureStarterCreditGrant, so the column default (0) applies.
    const result = await getOrgMetadata(orgId);

    expect(result).toEqual({
      orgId,
      tier: "free",
      credits: 0,
      defaultAgentId: null,
    });
  });
});

describe("getOrgBillingPeriod", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();
  });

  it("returns billing period from Stripe subscription item when currentPeriodEnd is not cached", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    const subId = uniqueId("sub");

    // Set subscription ID but no currentPeriodEnd — triggers Stripe fallback
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: subId,
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: null,
    });

    // Use a far-future date so the "don't cache past-dated value" guard
    // never kicks in regardless of when the test runs.
    const periodEndUnix = Math.floor(
      new Date("2099-05-01T00:00:00Z").getTime() / 1000,
    );

    stripeMocks.subscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [{ current_period_end: periodEndUnix }] },
    });

    const result = await getOrgBillingPeriod(orgId);

    if (!result) throw new Error("expected result to be non-null");
    expect(result.end).toEqual(new Date("2099-05-01T00:00:00Z"));

    // Start should be 1 month before end
    const expectedStart = new Date("2099-04-01T00:00:00Z");
    expect(result.start).toEqual(expectedStart);

    // Verify Stripe was called with the correct subscription ID
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledWith(subId);
    // invoices.retrieve MUST NOT be called — the subscription item carries
    // the period end directly, which eliminates an unnecessary round trip.
    expect(stripeMocks.invoicesRetrieve).not.toHaveBeenCalled();
  });

  it("returns null for free tier org without subscription", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    const result = await getOrgBillingPeriod(orgId);

    expect(result).toBeNull();
    expect(stripeMocks.subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("returns null when subscription has no items with current_period_end", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: null,
    });

    stripeMocks.subscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [] },
    });

    const result = await getOrgBillingPeriod(orgId);

    expect(result).toBeNull();
  });

  it("returns null and does NOT cache when refreshed periodEnd is still in the past", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    const subId = uniqueId("sub");
    const stalePeriodEnd = new Date("2020-01-01T00:00:00Z"); // stale cached value

    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: subId,
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: stalePeriodEnd,
    });

    // Stripe returns a past-dated value (simulates data corruption or field
    // confusion). Without the defensive guard this would persist the bad
    // value and cause an infinite refresh loop on every subsequent call.
    const pastPeriodEndUnix = Math.floor(
      new Date("2020-02-01T00:00:00Z").getTime() / 1000,
    );

    stripeMocks.subscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [{ current_period_end: pastPeriodEndUnix }] },
    });

    const result = await getOrgBillingPeriod(orgId);

    expect(result).toBeNull();
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledTimes(1);
  });

  it("refreshes from Stripe when currentPeriodEnd is in the past", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    const subId = uniqueId("sub");
    const stalePeriodEnd = new Date("2020-03-01T00:00:00Z"); // past date

    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: subId,
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: stalePeriodEnd,
    });

    const newPeriodEndUnix = Math.floor(
      new Date("2099-04-01T00:00:00Z").getTime() / 1000,
    );

    stripeMocks.subscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [{ current_period_end: newPeriodEndUnix }] },
    });

    const result = await getOrgBillingPeriod(orgId);

    if (!result) throw new Error("expected result to be non-null");
    expect(result.end).toEqual(new Date("2099-04-01T00:00:00Z"));
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledWith(subId);
    // invoices.retrieve MUST NOT be called anymore
    expect(stripeMocks.invoicesRetrieve).not.toHaveBeenCalled();
  });

  it("uses cached value when currentPeriodEnd is in the future", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    const futurePeriodEnd = new Date("2099-05-01T00:00:00Z"); // future date

    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: uniqueId("sub"),
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: futurePeriodEnd,
    });

    const result = await getOrgBillingPeriod(orgId);

    if (!result) throw new Error("expected result to be non-null");
    expect(result.end).toEqual(futurePeriodEnd);
    // Stripe should NOT have been called — we used the cached value
    expect(stripeMocks.subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("caches Stripe result so a second call does not hit Stripe again", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    const subId = uniqueId("sub");

    // Start with no cached period — triggers Stripe fallback on first call
    await updateOrgStripeFields(orgId, {
      stripeSubscriptionId: subId,
      stripeCustomerId: uniqueId("cus"),
      subscriptionStatus: "active",
      currentPeriodEnd: null,
    });

    const periodEndUnix = Math.floor(
      new Date("2099-05-01T00:00:00Z").getTime() / 1000,
    );

    stripeMocks.subscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [{ current_period_end: periodEndUnix }] },
    });

    // First call — fetches from Stripe and writes back to DB
    const firstResult = await getOrgBillingPeriod(orgId);
    if (!firstResult) throw new Error("expected firstResult to be non-null");
    expect(firstResult.end).toEqual(new Date("2099-05-01T00:00:00Z"));
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledTimes(1);

    // Second call — should use the cached DB value, not hit Stripe
    const secondResult = await getOrgBillingPeriod(orgId);
    if (!secondResult) throw new Error("expected secondResult to be non-null");
    expect(secondResult.end).toEqual(new Date("2099-05-01T00:00:00Z"));
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledTimes(1);
  });
});
