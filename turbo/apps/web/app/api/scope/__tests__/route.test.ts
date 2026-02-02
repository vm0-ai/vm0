import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST, PUT } from "../route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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

    it("should return 404 if user has no scope", async () => {
      // Create a unique user ID that has no scope
      mockClerk({ userId: `user-with-no-scope-${Date.now()}` });

      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("No scope configured");
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
      expect(data.type).toBe("personal");
      expect(data.id).toBeDefined();
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
      expect(data.type).toBe("personal");
      expect(data.id).toBeDefined();
      expect(data.slug).toBeDefined();
    });
  });
});
