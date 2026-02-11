import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST } from "../[token]/route";
import { POST as createOrg } from "../../org/route";
import { POST as createOrgInvite } from "../../org/invite/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/invite/[token]", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("WEB_APP_URL", "https://test.vm0.dev");
  });

  describe("GET /api/invite/[token] (get invitation details)", () => {
    it("should return 404 for invalid token", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/invite/invalid-token",
      );
      const response = await GET(request, {
        params: Promise.resolve({ token: "invalid-token" }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should return invitation details for valid token", async () => {
      const ownerId = `owner-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        },
      );
      await createOrg(createOrgRequest);

      // Create invite
      const inviteRequest = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const inviteResponse = await createOrgInvite(inviteRequest);
      const invite = await inviteResponse.json();

      // Get invitation details (no auth required)
      mockClerk({ userId: null });
      const request = createTestRequest(
        `http://localhost:3000/api/invite/${invite.token}`,
      );
      const response = await GET(request, {
        params: Promise.resolve({ token: invite.token }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.orgSlug).toBe(slug);
      expect(data.isValid).toBe(true);
      expect(data.expiresAt).toBeDefined();
    });
  });

  describe("POST /api/invite/[token] (accept invitation)", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/invite/some-token",
        {
          method: "POST",
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ token: "some-token" }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 for invalid token", async () => {
      const userId = `new-user-${Date.now()}`;
      mockClerk({ userId });

      const request = createTestRequest(
        "http://localhost:3000/api/invite/invalid-token",
        {
          method: "POST",
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ token: "invalid-token" }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should accept valid invitation", async () => {
      const ownerId = `owner-${Date.now()}`;
      const newUserId = `new-user-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        },
      );
      await createOrg(createOrgRequest);

      // Create invite
      const inviteRequest = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const inviteResponse = await createOrgInvite(inviteRequest);
      const invite = await inviteResponse.json();

      // Accept invite as new user
      mockClerk({ userId: newUserId });
      const request = createTestRequest(
        `http://localhost:3000/api/invite/${invite.token}`,
        {
          method: "POST",
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ token: invite.token }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.slug).toBe(slug);
      expect(data.type).toBe("organization");
    });

    it("should return 400 for already used invitation", async () => {
      const ownerId = `owner-${Date.now()}`;
      const user1Id = `user1-${Date.now()}`;
      const user2Id = `user2-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        },
      );
      await createOrg(createOrgRequest);

      // Create invite
      const inviteRequest = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const inviteResponse = await createOrgInvite(inviteRequest);
      const invite = await inviteResponse.json();

      // User 1 accepts invite
      mockClerk({ userId: user1Id });
      const request1 = createTestRequest(
        `http://localhost:3000/api/invite/${invite.token}`,
        {
          method: "POST",
        },
      );
      await POST(request1, {
        params: Promise.resolve({ token: invite.token }),
      });

      // User 2 tries to accept same invite
      mockClerk({ userId: user2Id });
      const request2 = createTestRequest(
        `http://localhost:3000/api/invite/${invite.token}`,
        {
          method: "POST",
        },
      );
      const response = await POST(request2, {
        params: Promise.resolve({ token: invite.token }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("expired or already been used");
    });

    it("should return 400 if user is already a member", async () => {
      const ownerId = `owner-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Create org
      const slug = `test-org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        },
      );
      await createOrg(createOrgRequest);

      // Create invite
      const inviteRequest = createTestRequest(
        "http://localhost:3000/api/org/invite",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const inviteResponse = await createOrgInvite(inviteRequest);
      const invite = await inviteResponse.json();

      // Owner tries to accept their own org's invite
      const request = createTestRequest(
        `http://localhost:3000/api/invite/${invite.token}`,
        {
          method: "POST",
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ token: invite.token }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("already a member");
    });
  });
});
