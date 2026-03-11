import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestScope,
  insertOrgCacheEntry,
  getOrgCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { getOrgData } from "../org-cache-service";

const context = testContext();

describe("getOrgData", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("fetches from Clerk and caches on miss", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    // Set up Clerk org with slug-based ID BEFORE creating scope
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestScope(slug);
    const clerkOrgId = `org_mock_${slug}`;

    const result = await getOrgData(clerkOrgId);

    expect(result).toEqual({
      clerkOrgId,
      slug,
      tier: "free",
    });

    // Verify cache row was created
    const cached = await getOrgCacheEntry(clerkOrgId);
    expect(cached).not.toBeNull();
    expect(cached!.slug).toBe(slug);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: clerkOrgId,
    });
  });

  it("returns cached data without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    mockClerk({ userId });
    await createTestScope(slug);
    const clerkOrgId = `org_mock_${slug}`;

    // Pre-populate cache with fresh entry
    await insertOrgCacheEntry({
      clerkOrgId,
      slug: "cached-slug",
      tier: "pro",
    });

    const result = await getOrgData(clerkOrgId);

    expect(result).toEqual({
      clerkOrgId,
      slug: "cached-slug",
      tier: "pro",
    });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).not.toHaveBeenCalled();
  });

  it("refetches from Clerk when cache is stale", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    // Set up Clerk org with slug-based ID BEFORE creating scope
    mockClerk({
      userId,
      clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
    });
    await createTestScope(slug);
    const clerkOrgId = `org_mock_${slug}`;

    // Pre-populate cache with stale entry (2 minutes ago)
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await insertOrgCacheEntry({
      clerkOrgId,
      slug: "old-slug",
      tier: "free",
      cachedAt: twoMinutesAgo,
    });

    const result = await getOrgData(clerkOrgId);

    // Should have fresh data from Clerk mock (slug = scope name from createOrganization)
    expect(result.slug).toBe(slug);
    expect(result.clerkOrgId).toBe(clerkOrgId);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.organizations.getOrganization).toHaveBeenCalledWith({
      organizationId: clerkOrgId,
    });

    // Verify cache was updated
    const cached = await getOrgCacheEntry(clerkOrgId);
    expect(cached!.slug).toBe(slug);
    expect(cached!.cachedAt.getTime()).toBeGreaterThan(twoMinutesAgo.getTime());
  });

  it("reads tier from Clerk publicMetadata", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    mockClerk({ userId });
    await createTestScope(slug);
    const clerkOrgId = `org_mock_${slug}`;

    // Override getOrganization to return tier in publicMetadata
    const client = await clerkClient();
    vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
      id: clerkOrgId,
      slug,
      name: slug,
      publicMetadata: { tier: "pro" },
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganization>
    >);

    const result = await getOrgData(clerkOrgId);

    expect(result.tier).toBe("pro");
  });

  it("throws when Clerk org has no slug", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");
    mockClerk({ userId });
    await createTestScope(slug);
    const clerkOrgId = `org_mock_${slug}`;

    // Override getOrganization to return null slug
    const client = await clerkClient();
    vi.mocked(client.organizations.getOrganization).mockResolvedValueOnce({
      id: clerkOrgId,
      slug: null,
      name: slug,
      publicMetadata: {},
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganization>
    >);

    await expect(getOrgData(clerkOrgId)).rejects.toThrow(
      `Clerk organization ${clerkOrgId} has no slug`,
    );
  });
});
