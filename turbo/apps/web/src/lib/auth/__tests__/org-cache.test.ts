import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestOrg,
  insertOrgCacheEntry,
  deleteOrgCacheEntry,
  getOrgCacheEntry,
  ensureOrgRow,
} from "../../../__tests__/api-test-helpers";
import { getOrgNameAndSlug, getOrgIdBySlug } from "../org-cache";

const context = testContext();

describe("getOrgNameAndSlug", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("fetches from Clerk and caches on miss", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestOrg(slug);
    const orgId = `org_mock_${slug}`;

    // Delete pre-populated orgCache to test cache-miss behavior
    await deleteOrgCacheEntry(orgId);

    const result = await getOrgNameAndSlug(orgId);

    expect(result).toEqual({
      orgId,
      slug,
      name: slug,
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

    const result = await getOrgNameAndSlug(orgId);

    expect(result).toEqual({
      orgId,
      slug: "cached-slug",
      name: "cached-slug",
    });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
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

    // Overwrite with a stale entry
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await insertOrgCacheEntry({
      orgId,
      slug: "old-slug",
      cachedAt: twoMinutesAgo,
    });

    const result = await getOrgNameAndSlug(orgId);

    // Should have fresh data from Clerk mock
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

    await expect(getOrgNameAndSlug(orgId)).rejects.toThrow(
      `Clerk organization ${orgId} has no slug`,
    );
  });
});

describe("getOrgIdBySlug", () => {
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

    const result = await getOrgIdBySlug(slug);

    expect(result).toBe(orgId);

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

  it("returns cached orgId without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug, name: slug }],
    });

    // Insert fresh cache entry and org row directly
    await insertOrgCacheEntry({ orgId, slug });
    await ensureOrgRow(orgId);

    const result = await getOrgIdBySlug(slug);

    expect(result).toBe(orgId);

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("returns null when slug not found in Clerk", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const result = await getOrgIdBySlug("nonexistent-slug");

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

    const result = await getOrgIdBySlug(slug);

    expect(result).toBe(orgId);

    // Verify Clerk API was called with slug param
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      slug,
    });
  });
});
