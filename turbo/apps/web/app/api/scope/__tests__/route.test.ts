import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST, PUT } from "../route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../src/env";

const context = testContext();

describe("/api/scope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/scope", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should auto-create scope for user with no scope", async () => {
      const userId = `user-with-no-scope-${Date.now()}`;
      mockClerk({ userId });

      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBeDefined();
      expect(data.slug).toMatch(/^user-[a-f0-9]{8}$/);
    });

    it("should auto-create scope with fallback slug on collision", async () => {
      // First, create a scope that will collide with the deterministic slug
      // by pre-occupying the slug that ensureDefaultScope would generate
      const collidingUserId = `collision-test-${Date.now()}`;

      // Import to compute the expected slug
      const { generateDefaultScopeSlug } = await import(
        "../../../../src/lib/scope/scope-service"
      );
      const expectedSlug = generateDefaultScopeSlug(collidingUserId);

      // Pre-occupy the deterministic slug with a different user
      const occupierUserId = `occupier-${Date.now()}`;
      mockClerk({ userId: occupierUserId });
      const occupyRequest = createTestRequest(
        "http://localhost:3000/api/scope",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: expectedSlug }),
        },
      );
      const occupyResponse = await POST(occupyRequest);
      expect(occupyResponse.status).toBe(201);

      // Now the colliding user triggers auto-creation via GET
      mockClerk({ userId: collidingUserId });
      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBeDefined();
      // Should have fallen back to a random slug, not the colliding one
      expect(data.slug).not.toBe(expectedSlug);
      expect(data.slug).toMatch(/^user-[a-f0-9]{8}$/);
    });

    it("should return same scope on repeated GET (idempotent auto-creation)", async () => {
      const userId = `idempotent-scope-${Date.now()}`;
      mockClerk({ userId });

      const request1 = createTestRequest("http://localhost:3000/api/scope");
      const response1 = await GET(request1);
      const data1 = await response1.json();

      const request2 = createTestRequest("http://localhost:3000/api/scope");
      const response2 = await GET(request2);
      const data2 = await response2.json();

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(data1.id).toBe(data2.id);
      expect(data1.slug).toBe(data2.slug);
    });
  });

  describe("POST /api/scope", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "test-scope" }),
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should create a scope successfully", async () => {
      // Create a unique user without a scope
      mockClerk({ userId: `new-user-${Date.now()}` });
      const slug = `api-test-${Date.now()}`;

      const request = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.slug).toBe(slug);
      expect(data.id).toBeDefined();
    });

    it("should return 400 (not 500) when scope slug already exists", async () => {
      // First user creates a scope with a slug
      const userId1 = `dup-slug-user1-${Date.now()}`;
      const slug = `dup-slug-test-${Date.now()}`;

      mockClerk({ userId: userId1 });
      const request1 = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const response1 = await POST(request1);
      expect(response1.status).toBe(201);

      // Second user tries to create a scope with the same slug
      // This should return 400 (already exists) not 500 (crash)
      const userId2 = `dup-slug-user2-${Date.now()}`;
      mockClerk({ userId: userId2 });
      const request2 = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const response2 = await POST(request2);
      const data = await response2.json();

      expect(response2.status).toBe(400);
      expect(data.error.message).toContain("already exists");
    });

    it("should reject duplicate scope creation for same user", async () => {
      // Create a user and their first scope
      const userId = `dup-test-user-${Date.now()}`;
      mockClerk({ userId });

      const slug1 = `dup-test-${Date.now()}`;
      const request1 = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug1 }),
      });
      await POST(request1);

      // Try to create another scope for same user
      const request2 = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: `${slug1}-2` }),
      });
      const response = await POST(request2);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.message).toContain("already have a scope");
    });

    describe("slug validation", () => {
      it("should reject slugs that are too short", async () => {
        mockClerk({ userId: `invalid-slug-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "ab" }),
        });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it("should reject slugs that are too long", async () => {
        mockClerk({ userId: `long-slug-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "a".repeat(65) }),
        });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it("should reject slugs with uppercase letters", async () => {
        mockClerk({ userId: `uppercase-slug-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "MySlug" }),
        });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it("should reject slugs with invalid characters", async () => {
        mockClerk({ userId: `invalid-char-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "my_slug" }),
        });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it("should reject slugs starting with hyphen", async () => {
        mockClerk({ userId: `hyphen-start-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "-myslug" }),
        });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it("should reject slugs ending with hyphen", async () => {
        mockClerk({ userId: `hyphen-end-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "myslug-" }),
        });
        const response = await POST(request);

        expect(response.status).toBe(400);
      });

      it("should reject reserved slugs", async () => {
        mockClerk({ userId: `reserved-slug-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "vm0" }),
        });
        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error.message).toContain("reserved");
      });

      it("should reject slugs starting with vm0", async () => {
        mockClerk({ userId: `vm0-prefix-user-${Date.now()}` });

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "vm0-custom" }),
        });
        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error.message).toContain("reserved");
      });

      it("should allow vm0-admin to create vm0-prefixed slug", async () => {
        const userId = `vm0-admin-user-${Date.now()}`;
        mockClerk({ userId, email: "admin@vm0.ai" });
        vi.stubEnv("VM0_ADMIN_USERS", "admin@vm0.ai");
        reloadEnv();

        const slug = `vm0-admin-test-${Date.now()}`;
        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(201);
        expect(data.slug).toBe(slug);
      });

      it("should reject vm0-prefixed slug for non-admin user", async () => {
        const userId = `vm0-nonadmin-user-${Date.now()}`;
        mockClerk({ userId, email: "user@example.com" });
        vi.stubEnv("VM0_ADMIN_USERS", "admin@vm0.ai");
        reloadEnv();

        const request = createTestRequest("http://localhost:3000/api/scope", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: "vm0-unauthorized" }),
        });
        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error.message).toContain("reserved");
      });
    });
  });

  describe("PUT /api/scope", () => {
    beforeEach(async () => {
      // Set up a user with an existing scope for PUT tests
      await context.setupUser();
    });

    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "new-slug", force: true }),
      });
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should require force flag to update", async () => {
      const request = createTestRequest("http://localhost:3000/api/scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "new-slug", force: false }),
      });
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("--force");
    });

    it("should update scope slug with force flag", async () => {
      const newSlug = `updated-${Date.now()}`;

      const request = createTestRequest("http://localhost:3000/api/scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug, force: true }),
      });
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.slug).toBe(newSlug);
    });
  });

  describe("GET /api/scope (after scope created)", () => {
    beforeEach(async () => {
      // Set up a user with a scope
      await context.setupUser();
    });

    it("should return user's scope", async () => {
      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBeDefined();
      expect(data.slug).toBeDefined();
    });
  });
});
