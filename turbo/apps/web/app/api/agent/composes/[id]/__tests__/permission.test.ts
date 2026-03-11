import { describe, it, expect, beforeEach } from "vitest";
import { GET as getCompose } from "../route";
import { POST as addPermission } from "../permissions/route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("Agent Compose Permission Checks", () => {
  let testComposeId: string;
  let ownerOrgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    ownerOrgId = user.orgId;

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  describe("Cross-User Access Control", () => {
    // Note: API returns 404 (not 403) for unauthorized access to prevent
    // information leakage about existence of private agents
    it("should deny access to another user's private compose (returns 404)", async () => {
      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // API returns 404 instead of 403 for security (don't leak existence of private agents)
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should allow access when compose is public", async () => {
      // Make compose public (as owner)
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );
      await addPermission(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should allow access when user email is in permission list", async () => {
      // Share with the default mock email (test@example.com)
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            granteeType: "email",
            granteeEmail: "test@example.com", // This is what mockClerk returns
          }),
        },
      );
      await addPermission(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Switch to another user (who has email test@example.com via mock)
      mockClerk({ userId: "other-user-123" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should still deny access when email does not match (returns 404)", async () => {
      const sharedEmail = "different@example.com";

      // Share with different email (as owner)
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            granteeType: "email",
            granteeEmail: sharedEmail,
          }),
        },
      );
      await addPermission(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Switch to another user (with test@example.com email - doesn't match)
      mockClerk({ userId: "other-user-123" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // API returns 404 instead of 403 for security
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should allow access when user is a member of the same org (JWT fast path)", async () => {
      // Switch to another user whose active org matches the compose's org
      // This exercises the JWT fast path (authResult.orgId === compose.orgId)
      mockClerk({
        userId: "other-user-123",
        orgId: ownerOrgId,
        clerkOrgs: [
          {
            id: ownerOrgId,
            slug: "shared-org",
            name: "Shared Org",
          },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should allow access via Clerk API fallback when active org differs", async () => {
      // Switch to another user who belongs to the owner's org but has a
      // different active org in their session. This exercises the Clerk API
      // fallback path (users.getOrganizationMembershipList).
      const differentOrgId = "org_different_active";
      mockClerk({
        userId: "other-user-456",
        orgId: differentOrgId,
        clerkOrgs: [
          {
            id: differentOrgId,
            slug: "different-org",
            name: "Different Org",
          },
          {
            id: ownerOrgId,
            slug: "shared-org",
            name: "Shared Org",
          },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should allow access from cache without calling Clerk API", async () => {
      // Pre-seed a fresh cache entry for a user who is NOT in the clerkOrgs list.
      // If the cache is working, the user gets access without Clerk API finding membership.
      const cacheUserId = "cache-user-789";
      await insertOrgMembersCacheEntry({
        orgId: ownerOrgId,
        userId: cacheUserId,
        cachedAt: new Date(), // fresh
      });

      // Mock user with a different active org and NO membership in the owner's org
      mockClerk({
        userId: cacheUserId,
        orgId: "org_unrelated",
        clerkOrgs: [
          { id: "org_unrelated", slug: "unrelated", name: "Unrelated Org" },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // Access granted via cache hit — no Clerk API call needed
      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should re-query Clerk API when cache entry is stale", async () => {
      // Pre-seed a stale cache entry (older than 1 minute TTL)
      const staleUserId = "stale-cache-user-101";
      const staleCachedAt = new Date(Date.now() - 120_000); // 2 minutes ago
      await insertOrgMembersCacheEntry({
        orgId: ownerOrgId,
        userId: staleUserId,
        cachedAt: staleCachedAt,
      });

      // Mock user with a different active org but WITH membership in owner's org
      // so the Clerk API fallback succeeds
      mockClerk({
        userId: staleUserId,
        orgId: "org_other_active",
        clerkOrgs: [
          { id: "org_other_active", slug: "other", name: "Other Org" },
          { id: ownerOrgId, slug: "shared-org", name: "Shared Org" },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // Access granted via Clerk API fallback (stale cache was bypassed)
      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should deny access when cache is stale and user is not a member", async () => {
      // Pre-seed a stale cache entry
      const nonMemberUserId = "non-member-user-202";
      const staleCachedAt = new Date(Date.now() - 120_000); // 2 minutes ago
      await insertOrgMembersCacheEntry({
        orgId: ownerOrgId,
        userId: nonMemberUserId,
        cachedAt: staleCachedAt,
      });

      // Mock user with NO membership in the owner's org
      mockClerk({
        userId: nonMemberUserId,
        orgId: "org_unrelated",
        clerkOrgs: [
          { id: "org_unrelated", slug: "unrelated", name: "Unrelated Org" },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // Stale cache does not grant access; Clerk API says not a member → denied
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should always allow owner to access their compose", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });
  });
});
