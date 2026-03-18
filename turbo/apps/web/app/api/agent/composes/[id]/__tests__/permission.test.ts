import { describe, it, expect, beforeEach } from "vitest";
import { GET as getCompose } from "../route";
import {
  createTestRequest,
  createTestCompose,
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
      // Switch to another user (different org)
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

    it("should allow access when user is a member of the same org", async () => {
      // Switch to another user whose active org matches the compose's org.
      // Compose access is org-scoped: same org = access granted.
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

    it("should deny access when active org differs from compose org", async () => {
      // User is a member of the owner's org, but their active org is different.
      // Compose access is scoped to the caller's active org — cross-org access
      // is not allowed even if the user is a member of the compose's org.
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

      // Active org differs from compose's org — denied
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
