import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import type { StripeMockFns } from "../../../__tests__/stripe-mock";
import {
  createTestOrg,
  insertOrgCacheEntry,
  deleteOrgCacheEntry,
  getOrgCacheEntry,
  updateOrgTier,
  updateOrgStripeFields,
  ensureOrgRow,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import {
  getOrgData,
  getOrgBySlug,
  getOrgBillingPeriod,
  batchGetOrgData,
} from "../org-cache-service";

// Mock stripe module (external dependency)
const stripeMocks = vi.hoisted<StripeMockFns>(() => ({
  subscriptionsRetrieve: vi.fn(),
  subscriptionsUpdate: vi.fn(),
  subscriptionsCancel: vi.fn(),
  invoicesRetrieve: vi.fn(),
  invoicesList: vi.fn(),
  customersCreate: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  billingPortalSessionsCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
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
}));

const context = testContext();

describe("getOrgData", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("fetches from Clerk and caches on miss", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    // Set up Clerk org with slug-based ID BEFORE creating org
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Delete pre-populated orgCache to test cache-miss behavior
    await deleteOrgCacheEntry(orgId);

    const result = await getOrgData(orgId);

    expect(result).toEqual({
      orgId,
      slug,
      name: slug,
      tier: "free",
    });

    // Verify cache row was created
    const cached = await getOrgCacheEntry(orgId);
    expect(cached).not.toBeNull();
    expect(cached!.slug).toBe(slug);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: orgId,
    });
  });

  it("returns cached data without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Pre-populate cache with fresh entry (different slug)
    await insertOrgCacheEntry({
      orgId,
      slug: "cached-slug",
    });

    const result = await getOrgData(orgId);

    expect(result).toEqual({
      orgId,
      slug: "cached-slug",
      name: "cached-slug",
      tier: "free",
    });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("refetches from Clerk when cache is stale", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    // Set up Clerk org with slug-based ID BEFORE creating org
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Overwrite the fresh orgCache entry from createTestOrg with a stale one
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await insertOrgCacheEntry({
      orgId,
      slug: "old-slug",
      cachedAt: twoMinutesAgo,
    });

    const result = await getOrgData(orgId);

    // Should have fresh data from Clerk mock (slug = org name from createOrganization)
    expect(result.slug).toBe(slug);
    expect(result.orgId).toBe(orgId);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: orgId,
    });

    // Verify cache was updated
    const cached = await getOrgCacheEntry(orgId);
    expect(cached!.slug).toBe(slug);
    expect(cached!.cachedAt.getTime()).toBeGreaterThan(twoMinutesAgo.getTime());
  });

  it("reads tier from org table", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Update tier in org table
    await updateOrgTier(orgId, "pro");

    const result = await getOrgData(orgId);

    expect(result.tier).toBe("pro");
  });

  it("returns DB tier directly when DB has non-free on cache miss", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    const { id: orgId } = await createTestOrg(slug);

    await updateOrgTier(orgId, "pro");

    const result = await getOrgData(orgId);
    expect(result.tier).toBe("pro");
  });

  it("returns free on cache hit when DB has free (no Clerk fallback)", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Cache is fresh (from createTestOrg), DB tier is "free"
    // No Clerk call happens, so no fallback possible
    const result = await getOrgData(orgId);
    expect(result.tier).toBe("free");

    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("throws when Clerk org has no slug", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Delete cache to force Clerk fetch
    await deleteOrgCacheEntry(orgId);

    // Override getOrganization to return null slug
    const client = await clerkClient();
    vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
      id: orgId,
      slug: null,
      name: slug,
      publicMetadata: {},
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganization>
    >);

    await expect(getOrgData(orgId)).rejects.toThrow(
      `Clerk organization ${orgId} has no slug`,
    );
  });
});

describe("getOrgBySlug", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("fetches from Clerk by slug and caches on miss", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug, name: slug }],
    });

    // No org_cache entry — this is a cache-miss scenario
    const result = await getOrgBySlug(slug);

    expect(result).toEqual({
      orgId,
      slug,
      name: slug,
      tier: "free",
    });

    // Verify cache row was created
    const cached = await getOrgCacheEntry(orgId);
    expect(cached).not.toBeNull();
    expect(cached!.slug).toBe(slug);

    // Verify Clerk API was called with slug param
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      slug,
    });
  });

  it("returns cached data without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug, name: slug }],
    });

    // Insert fresh cache entry and org row directly (bypass createTestOrg
    // which uses org_mock_${userId} as orgId, not org_mock_${slug})
    await insertOrgCacheEntry({ orgId, slug });
    await ensureOrgRow(orgId);
    await updateOrgTier(orgId, "pro");

    const result = await getOrgBySlug(slug);

    expect(result).toEqual({ orgId, slug, name: slug, tier: "pro" });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("returns null when slug not found in Clerk", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const result = await getOrgBySlug("nonexistent-slug");

    expect(result).toBeNull();
  });

  it("refetches from Clerk when cache is stale", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug, name: slug }],
    });

    // Insert stale cache entry directly
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await insertOrgCacheEntry({
      orgId,
      slug,
      cachedAt: twoMinutesAgo,
    });

    const result = await getOrgBySlug(slug);

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe(orgId);

    // Verify Clerk API was called with slug param
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      slug,
    });
  });
});

describe("getOrgBillingPeriod", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();
  });

  it("returns billing period from Stripe invoice when currentPeriodEnd is not cached", async () => {
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

    const periodEndUnix = Math.floor(
      new Date("2026-05-01T00:00:00Z").getTime() / 1000,
    );

    stripeMocks.subscriptionsRetrieve.mockResolvedValueOnce({
      latest_invoice: "inv_abc123",
    });
    stripeMocks.invoicesRetrieve.mockResolvedValueOnce({
      period_end: periodEndUnix,
    });

    const result = await getOrgBillingPeriod(orgId);

    expect(result).not.toBeNull();
    expect(result!.end).toEqual(new Date("2026-05-01T00:00:00Z"));

    // Start should be 1 month before end
    const expectedStart = new Date("2026-04-01T00:00:00Z");
    expect(result!.start).toEqual(expectedStart);

    // Verify Stripe was called with the correct subscription ID
    expect(stripeMocks.subscriptionsRetrieve).toHaveBeenCalledWith(subId);
    expect(stripeMocks.invoicesRetrieve).toHaveBeenCalledWith("inv_abc123");
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

  it("returns null when subscription has no latest_invoice", async () => {
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
      latest_invoice: null,
    });

    const result = await getOrgBillingPeriod(orgId);

    expect(result).toBeNull();
  });
});

describe("batchGetOrgData", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns empty map for empty input", async () => {
    const result = await batchGetOrgData([]);
    expect(result).toEqual(new Map());
  });

  it("returns cached data without Clerk calls when all fresh", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");
    const orgId1 = uniqueId("org");
    const orgId2 = uniqueId("org");
    mockClerk({ userId });

    // Pre-populate fresh cache entries and org rows directly
    await insertOrgCacheEntry({ orgId: orgId1, slug: slug1 });
    await ensureOrgRow(orgId1);
    await insertOrgCacheEntry({ orgId: orgId2, slug: slug2 });
    await ensureOrgRow(orgId2);

    const result = await batchGetOrgData([orgId1, orgId2]);

    expect(result.size).toBe(2);
    expect(result.get(orgId1)).toEqual({
      orgId: orgId1,
      slug: slug1,
      name: slug1,
      tier: "free",
    });
    expect(result.get(orgId2)).toEqual({
      orgId: orgId2,
      slug: slug2,
      name: slug2,
      tier: "free",
    });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("fetches from Clerk for cache misses", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Delete cache to force Clerk fetch
    await deleteOrgCacheEntry(orgId);

    const result = await batchGetOrgData([orgId]);

    expect(result.size).toBe(1);
    expect(result.get(orgId)).toEqual({
      orgId,
      slug,
      name: slug,
      tier: "free",
    });

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: orgId,
    });

    // Verify cache was populated
    const cached = await getOrgCacheEntry(orgId);
    expect(cached).not.toBeNull();
    expect(cached!.slug).toBe(slug);
  });

  it("handles mix of cache hits and misses", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");
    const orgId1 = uniqueId("org");
    const orgId2 = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [
        { id: orgId1, slug: slug1, name: slug1 },
        { id: orgId2, slug: slug2, name: slug2 },
      ],
    });

    // Pre-populate fresh cache for org1 only
    await insertOrgCacheEntry({ orgId: orgId1, slug: slug1 });
    await ensureOrgRow(orgId1);
    // Org2: ensure org row exists but NO cache entry (cache miss)
    await ensureOrgRow(orgId2);

    const result = await batchGetOrgData([orgId1, orgId2]);

    expect(result.size).toBe(2);
    expect(result.get(orgId1)?.slug).toBe(slug1);
    expect(result.get(orgId2)?.slug).toBe(slug2);

    // Clerk should only have been called for the cache-miss org
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledTimes(1);
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: orgId2,
    });
  });

  it("reads tier from org table", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({ userId });
    const { id: orgId } = await createTestOrg(slug);

    // Update tier in org table
    await updateOrgTier(orgId, "pro");

    const result = await batchGetOrgData([orgId]);

    expect(result.get(orgId)?.tier).toBe("pro");
  });

  it("refetches from Clerk when cache is stale", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Overwrite with stale cache entry
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await insertOrgCacheEntry({
      orgId,
      slug: "old-slug",
      cachedAt: twoMinutesAgo,
    });

    const result = await batchGetOrgData([orgId]);

    expect(result.get(orgId)?.slug).toBe(slug);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: orgId,
    });
  });
});
