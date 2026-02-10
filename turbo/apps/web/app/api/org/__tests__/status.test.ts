import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../status/route";
import { POST as createOrg } from "../route";
import {
  createTestRequest,
  addTestOrgMember,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/org/status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/org/status", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/org/status");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 if user has no organization", async () => {
      mockClerk({ userId: `user-no-org-${Date.now()}` });

      const request = createTestRequest("http://localhost:3000/api/org/status");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("don't have an organization");
    });

    it("should return organization status with members", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createResponse = await createOrg(createRequest);
      const org = await createResponse.json();

      // Get status
      const request = createTestRequest("http://localhost:3000/api/org/status");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(org.id);
      expect(data.slug).toBe(slug);
      expect(data.type).toBe("organization");
      expect(data.members).toHaveLength(1);
      expect(data.members[0].userId).toBe(userId);
      expect(data.members[0].role).toBe("owner");
      expect(data.memberCount).toBe(1);
    });

    it("should return status for org specified in X-VM0-Scope header", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `scoped-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createResponse = await createOrg(createRequest);
      const org = await createResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Get status as member with scope header
      mockClerk({ userId: memberId });
      const request = createTestRequest(
        "http://localhost:3000/api/org/status",
        {
          headers: {
            "x-vm0-scope": slug,
          },
        },
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.slug).toBe(slug);
      expect(data.members).toHaveLength(2);
      expect(data.memberCount).toBe(2);
    });

    it("should return 403 if user is not a member", async () => {
      const ownerId = `owner-${Date.now()}`;
      const nonMemberId = `non-member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `private-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await createOrg(createRequest);

      // Try to get status as non-member
      mockClerk({ userId: nonMemberId });
      const request = createTestRequest(
        "http://localhost:3000/api/org/status",
        {
          headers: {
            "x-vm0-scope": slug,
          },
        },
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("don't have access");
    });
  });
});
