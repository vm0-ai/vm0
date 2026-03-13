import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { insertOrgCacheEntry } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { getDefaultOrgByUserId } from "../org-service";

const context = testContext();

describe("getDefaultOrgByUserId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return null when user has no org", async () => {
    const userId = uniqueId("no-scope-user");
    mockClerk({ userId, clerkOrgs: [] });

    const result = await getDefaultOrgByUserId(userId);

    expect(result).toBeNull();
  });

  it("should return org from org_cache for user with Clerk org", async () => {
    const userId = uniqueId("test-user");
    const orgId = `org_mock_${userId}`;
    const slug = uniqueId("org");
    mockClerk({ userId });

    // Pre-populate org_cache
    await insertOrgCacheEntry({ orgId, slug, tier: "free" });

    const result = await getDefaultOrgByUserId(userId);

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe(orgId);
    expect(result!.slug).toBe(slug);
  });
});
