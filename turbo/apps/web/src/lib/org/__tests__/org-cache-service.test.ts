import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestOrg,
  insertOrgCacheEntry,
  deleteOrgCacheEntry,
  getOrgCacheEntry,
  updateOrgTier,
  ensureOrgRow,
} from "../../../__tests__/api-test-helpers";
import { getOrgData, getOrgBySlug } from "../org-cache-service";

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

  it("falls back to Clerk tier on cache miss when DB has free", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Ensure org row exists for this orgId (createTestOrg uses org_mock_${userId})
    await ensureOrgRow(orgId);

    // Delete cache to force Clerk fetch
    await deleteOrgCacheEntry(orgId);

    // Override getOrganization to return tier in publicMetadata
    const client = await clerkClient();
    vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
      id: orgId,
      slug,
      name: slug,
      publicMetadata: { tier: "pro" },
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganization>
    >);

    const result = await getOrgData(orgId);
    expect(result.tier).toBe("pro");

    // Verify backfill (fire-and-forget, wait a tick)
    await new Promise((r) => setTimeout(r, 50));

    // Re-read via getOrgData with fresh cache (just written above)
    // to confirm the DB was updated
    const recheck = await getOrgData(orgId);
    expect(recheck.tier).toBe("pro");
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
