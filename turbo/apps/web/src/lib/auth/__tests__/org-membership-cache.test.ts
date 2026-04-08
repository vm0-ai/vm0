import { describe, it, expect, beforeEach, vi } from "vitest";
import { testContext } from "../../../__tests__/test-helpers";
import {
  insertOrgCacheEntry,
  insertOrgMembersCacheEntry,
  findOrgMembersCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { getMemberRole } from "../org-membership-cache";

const context = testContext();

describe("getMemberRole", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return null for a user not in the org", async () => {
    const { userId } = await context.setupUser();

    // Query an org the user is NOT a member of
    const foreignOrgId = "org_foreign_no_membership";
    await insertOrgCacheEntry({ orgId: foreignOrgId, slug: "foreign-org" });

    const result = await getMemberRole(foreignOrgId, userId);
    expect(result).toBeNull();
  });

  it("should return role from Clerk API on cache miss", async () => {
    const { userId, orgId } = await context.setupUser();

    // No cache entry exists — should call Clerk API
    const result = await getMemberRole(orgId, userId);

    expect(result).not.toBeNull();
    expect(result!.role).toBe("admin");
  });

  it("should return cached role on cache hit without Clerk API call", async () => {
    const { userId, orgId } = await context.setupUser();

    // Pre-populate cache
    await insertOrgMembersCacheEntry({ orgId, userId, role: "member" });

    // Mock Clerk to return a different role — if cache is used, we should get "member"
    mockClerk({ userId });

    const result = await getMemberRole(orgId, userId);
    expect(result).not.toBeNull();
    expect(result!.role).toBe("member"); // From cache, not Clerk
  });

  it("should refresh cache after TTL expires", async () => {
    const { userId, orgId } = await context.setupUser();

    // Insert a stale cache entry (2 minutes old)
    const staleTime = new Date(Date.now() - 120_000);
    await insertOrgMembersCacheEntry({
      orgId,
      userId,
      role: "member",
      cachedAt: staleTime,
    });

    // Clerk returns admin role — should override stale cache
    const result = await getMemberRole(orgId, userId);
    expect(result).not.toBeNull();
    expect(result!.role).toBe("admin"); // From Clerk, not stale cache
  });

  it("should delete stale cache when user is no longer a member", async () => {
    const { userId } = await context.setupUser();

    // Create a cache entry for an org the user is NOT actually a member of
    const foreignOrgId = "org_foreign_stale";
    await insertOrgCacheEntry({ orgId: foreignOrgId, slug: "stale-org" });

    const staleTime = new Date(Date.now() - 120_000);
    await insertOrgMembersCacheEntry({
      orgId: foreignOrgId,
      userId,
      role: "admin",
      cachedAt: staleTime,
    });

    // getMemberRole should check Clerk, find no membership, return null
    const result = await getMemberRole(foreignOrgId, userId);
    expect(result).toBeNull();

    // Wait for fire-and-forget cache delete to complete
    await vi.waitFor(async () => {
      const cached = await findOrgMembersCacheEntry(foreignOrgId, userId);
      expect(cached).toBeUndefined();
    });
  });
});
