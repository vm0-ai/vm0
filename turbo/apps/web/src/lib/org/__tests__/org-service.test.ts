import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import {
  insertOrgCacheEntry,
  ensureOrgRow,
} from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { resolveOrgOrNull } from "../resolve-org";

const context = testContext();

describe("resolveOrgOrNull", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return null when user has no org", async () => {
    // setupUser initializes services (db, etc.) needed by resolveOrg
    await context.setupUser();

    // Re-mock Clerk with a user that has no orgs and no active org in JWT
    const userId = uniqueId("no-org-user");
    mockClerk({ userId, orgId: null, clerkOrgs: [] });

    const result = await resolveOrgOrNull({ userId });

    expect(result).toBeNull();
  });

  it("should return org from org_cache for user with Clerk org", async () => {
    // setupUser initializes services (db, etc.) needed by resolveOrg
    await context.setupUser();

    // Re-mock Clerk with a specific user and explicit orgId in JWT
    const userId = uniqueId("test-user");
    const orgId = `org_mock_${userId}`;
    const slug = uniqueId("org");
    mockClerk({ userId, orgId });

    // Pre-populate org_cache and org_metadata
    await insertOrgCacheEntry({ orgId, slug });
    await ensureOrgRow(orgId);

    const result = await resolveOrgOrNull({ userId, orgId, orgRole: "admin" });

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe(orgId);
  });
});
