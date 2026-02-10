import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/org", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("POST /api/org (create organization)", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "my-org" }),
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should create an organization successfully", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });
      const slug = `test-org-${Date.now()}`;

      const request = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.slug).toBe(slug);
      expect(data.type).toBe("organization");
      expect(data.id).toBeDefined();
    });

    it("should reject duplicate organization creation for same user", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create first org
      const slug1 = `test-org-${Date.now()}`;
      const request1 = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug1 }),
      });
      await POST(request1);

      // Try to create second org
      const request2 = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: `${slug1}-2` }),
      });
      const response = await POST(request2);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("only create one organization");
    });

    it("should reject duplicate slug", async () => {
      const slug = `dup-slug-${Date.now()}`;

      // User 1 creates org
      mockClerk({ userId: `user1-${Date.now()}` });
      const request1 = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await POST(request1);

      // User 2 tries to create org with same slug
      mockClerk({ userId: `user2-${Date.now()}` });
      const request2 = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const response = await POST(request2);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.message).toContain("already exists");
    });
  });

  describe("GET /api/org (get owned organization)", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/org");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 if user has no organization", async () => {
      mockClerk({ userId: `user-no-org-${Date.now()}` });

      const request = createTestRequest("http://localhost:3000/api/org");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("don't have an organization");
    });

    it("should return user's owned organization", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create org first
      const slug = `test-org-${Date.now()}`;
      const createRequest = createTestRequest("http://localhost:3000/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await POST(createRequest);

      // Get org
      const request = createTestRequest("http://localhost:3000/api/org");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.slug).toBe(slug);
      expect(data.type).toBe("organization");
    });
  });
});
