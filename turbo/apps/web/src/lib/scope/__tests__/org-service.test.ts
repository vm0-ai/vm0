import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { insertOrgCacheEntry } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { getDefaultOrgByUserId, generateDefaultOrgSlug } from "../org-service";

const context = testContext();

describe("getDefaultOrgByUserId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return null when user has no scope", async () => {
    const userId = uniqueId("no-scope-user");
    mockClerk({ userId, clerkOrgs: [] });

    const result = await getDefaultOrgByUserId(userId);

    expect(result).toBeNull();
  });

  it("should return scope from org_cache for user with Clerk org", async () => {
    const userId = uniqueId("test-user");
    const orgId = `org_mock_${userId}`;
    const slug = uniqueId("scope");
    mockClerk({ userId });

    // Pre-populate org_cache
    await insertOrgCacheEntry({ orgId, slug, tier: "free" });

    const result = await getDefaultOrgByUserId(userId);

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe(orgId);
    expect(result!.slug).toBe(slug);
  });
});

describe("generateDefaultOrgSlug", () => {
  it("should generate deterministic slug from userId", () => {
    const slug1 = generateDefaultOrgSlug("user_abc");
    const slug2 = generateDefaultOrgSlug("user_abc");
    expect(slug1).toBe(slug2);
    expect(slug1).toMatch(/^user-[a-f0-9]{8}$/);
  });

  it("should generate different slugs for different userIds", () => {
    const slug1 = generateDefaultOrgSlug("user_abc");
    const slug2 = generateDefaultOrgSlug("user_xyz");
    expect(slug1).not.toBe(slug2);
  });
});
