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
    // setupUser initializes services (db, etc.) needed by getDefaultOrg
    await context.setupUser();

    // Re-mock Clerk with a user that has no orgs
    const userId = uniqueId("no-org-user");
    mockClerk({ userId, clerkOrgs: [] });

    const result = await getDefaultOrgByUserId(userId);

    expect(result).toBeNull();
  });

  it("should return org from org_cache for user with Clerk org", async () => {
    // setupUser initializes services (db, etc.) needed by getDefaultOrg
    await context.setupUser();

    // Re-mock Clerk with a specific user
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
