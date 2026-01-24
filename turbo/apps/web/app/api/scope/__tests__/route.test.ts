import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, PUT } from "../route";
import { initServices } from "../../../../src/lib/init-services";
import { scopes } from "../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";

// Mock Clerk auth (external SaaS)
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { auth } from "@clerk/nextjs/server";

const mockAuth = vi.mocked(auth);

describe("/api/scope", () => {
  const testUserId = "test-user-scope-api";
  const testUserId2 = "test-user-scope-api-2";

  beforeAll(() => {
    initServices();

    // Mock Clerk auth to return test user
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);
  });

  afterAll(async () => {
    // Cleanup: Delete all test scopes
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.ownerId, testUserId));
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.ownerId, testUserId2));
  });

  describe("GET /api/scope", () => {
    it("should require authentication", async () => {
      mockAuth.mockResolvedValueOnce({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/scope", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 if user has no scope", async () => {
      mockAuth.mockResolvedValueOnce({
        userId: "user-with-no-scope",
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/scope", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("No scope configured");
    });
  });

  describe("POST /api/scope", () => {
    it("should require authentication", async () => {
      mockAuth.mockResolvedValueOnce({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/scope", {
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
      const slug = `api-test-${Date.now()}`;

      const request = new NextRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, displayName: "Test Scope" }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.slug).toBe(slug);
      expect(data.displayName).toBe("Test Scope");
      expect(data.type).toBe("personal");
      expect(data.id).toBeDefined();
    });

    it("should reject duplicate scope creation for same user", async () => {
      const slug = `dup-test-${Date.now()}`;

      // Create first scope
      const request1 = new NextRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await POST(request1);

      // Try to create another scope for same user
      const request2 = new NextRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: `${slug}-2` }),
      });

      const response = await POST(request2);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.message).toContain("already have a scope");
    });

    it("should reject invalid slug format", async () => {
      // Use different user without scope

      const request = new NextRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "AB" }), // Too short
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it("should reject reserved slugs", async () => {
      // Use different user without scope

      const request = new NextRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "vm0" }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("reserved");
    });
  });

  describe("PUT /api/scope", () => {
    it("should require authentication", async () => {
      mockAuth.mockResolvedValueOnce({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = new NextRequest("http://localhost:3000/api/scope", {
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
      const request = new NextRequest("http://localhost:3000/api/scope", {
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

      const request = new NextRequest("http://localhost:3000/api/scope", {
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
    it("should return user's scope", async () => {
      const request = new NextRequest("http://localhost:3000/api/scope", {
        method: "GET",
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.type).toBe("personal");
      expect(data.id).toBeDefined();
      expect(data.slug).toBeDefined();
    });
  });
});
