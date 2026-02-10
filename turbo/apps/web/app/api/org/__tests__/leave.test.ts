import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../leave/route";
import { POST as createOrg } from "../route";
import {
  createTestRequest,
  addTestOrgMember,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/org/leave", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("POST /api/org/leave", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/org/leave", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vm0-scope": "some-org",
        },
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should require X-VM0-Scope header", async () => {
      mockClerk({ userId: `test-user-${Date.now()}` });

      const request = createTestRequest("http://localhost:3000/api/org/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("X-VM0-Scope header is required");
    });

    it("should allow member to leave organization", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const createResponse = await createOrg(createRequest);
      const org = await createResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // Member leaves
      mockClerk({ userId: memberId });
      const request = createTestRequest("http://localhost:3000/api/org/leave", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vm0-scope": slug,
        },
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should prevent owner from leaving", async () => {
      const ownerId = `owner-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await createOrg(createRequest);

      // Owner tries to leave
      const request = createTestRequest("http://localhost:3000/api/org/leave", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vm0-scope": slug,
        },
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("Owner cannot leave");
    });

    it("should return 404 if user is not a member", async () => {
      const ownerId = `owner-${Date.now()}`;
      const nonMemberId = `non-member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await createOrg(createRequest);

      // Non-member tries to leave
      mockClerk({ userId: nonMemberId });
      const request = createTestRequest("http://localhost:3000/api/org/leave", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vm0-scope": slug,
        },
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("don't have access");
    });
  });
});
