import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../invite/route";
import { POST as createOrg } from "../route";
import {
  createTestRequest,
  addTestOrgMember,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/org/invite", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("WEB_APP_URL", "https://test.vm0.dev");
  });

  describe("POST /api/org/invite", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 if user has no organization", async () => {
      mockClerk({ userId: `user-no-org-${Date.now()}` });

      const request = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("don't have an organization");
    });

    it("should create invite link for owner", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await createOrg(createRequest);

      // Create invite
      const request = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.token).toBeDefined();
      expect(data.url).toContain("https://test.vm0.dev/invite/");
      expect(data.expiresAt).toBeDefined();
    });

    it("should return 403 if user is member but not owner", async () => {
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

      // Try to create invite as member
      mockClerk({ userId: memberId });
      const request = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-vm0-scope": slug,
          },
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("Only the organization owner");
    });

    it("should return 500 if WEB_APP_URL is not set", async () => {
      vi.stubEnv("WEB_APP_URL", "");

      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await createOrg(createRequest);

      // Try to create invite
      const request = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.message).toContain("WEB_APP_URL not set");
    });
  });
});
