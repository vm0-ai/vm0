import { describe, it, expect, beforeEach } from "vitest";
import { DELETE } from "../members/[userId]/route";
import { POST as createOrg } from "../route";
import {
  createTestRequest,
  addTestOrgMember,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/org/members/:userId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("DELETE /api/org/members/:userId", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/org/members/user-123",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ userId: "user-123" }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 if owner has no organization", async () => {
      mockClerk({ userId: `user-no-org-${Date.now()}` });

      const request = createTestRequest(
        "http://localhost:3000/api/org/members/user-123",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ userId: "user-123" }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("don't have an organization");
    });

    it("should allow owner to remove member", async () => {
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

      // Owner removes member
      const request = createTestRequest(
        `http://localhost:3000/api/org/members/${memberId}`,
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ userId: memberId }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should prevent member from removing others", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      const targetId = `target-${Date.now()}`;
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

      // Add members
      await addTestOrgMember(org.id, memberId, "member");
      await addTestOrgMember(org.id, targetId, "member");

      // Member tries to remove another member
      mockClerk({ userId: memberId });
      const request = createTestRequest(
        `http://localhost:3000/api/org/members/${targetId}`,
        {
          method: "DELETE",
          headers: {
            "x-vm0-scope": slug,
          },
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ userId: targetId }),
      });
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("Only the organization owner");
    });

    it("should prevent removing the owner", async () => {
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

      // Owner tries to remove self
      const request = createTestRequest(
        `http://localhost:3000/api/org/members/${ownerId}`,
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ userId: ownerId }),
      });
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain(
        "Cannot remove the organization owner",
      );
    });

    it("should return 404 if member not found", async () => {
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

      // Try to remove non-existent member
      const request = createTestRequest(
        "http://localhost:3000/api/org/members/non-existent-user",
        {
          method: "DELETE",
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ userId: "non-existent-user" }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });
  });
});
