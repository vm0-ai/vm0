import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
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
      // JIT discovery uses Clerk org slug, which starts with "org-"
      expect(data.slug).toBeDefined();
    });

    it("should auto-create scope with fallback slug on collision", async () => {
      // JIT discovery uses Clerk org slug. Pre-occupy it to trigger fallback.
      const clerkOrgSlug = `collision-slug-${Date.now()}`;

      // Pre-occupy the Clerk org slug with a different user
      const occupierUserId = `occupier-${Date.now()}`;
      mockClerk({ userId: occupierUserId });
      const occupyRequest = createTestRequest(
        "http://localhost:3000/api/scope",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: clerkOrgSlug }),
        },
      );
      const occupyResponse = await POST(occupyRequest);
      expect(occupyResponse.status).toBe(201);

      // Now a user whose Clerk org has the colliding slug triggers auto-creation
      const collidingUserId = `collision-test-${Date.now()}`;
      mockClerk({
        userId: collidingUserId,
        clerkOrgs: [
          {
            id: `org_collision_${Date.now()}`,
            slug: clerkOrgSlug,
            name: "Collision Org",
          },
        ],
      });
      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBeDefined();
      // Should have fallen back to user-{hash}, not the colliding slug
      expect(data.slug).not.toBe(clerkOrgSlug);
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

    it("should dual-write slug to Clerk org on update", async () => {
      const newSlug = `dualwrite-${Date.now()}`;

      const request = createTestRequest("http://localhost:3000/api/scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug, force: true }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);

      const client = await clerkClient();
      expect(client.organizations.updateOrganization).toHaveBeenCalledWith(
        expect.stringMatching(/^org_mock_/),
        { slug: newSlug },
      );
    });

    it("should succeed even if Clerk dual-write fails", async () => {
      const client = await clerkClient();
      vi.mocked(client.organizations.updateOrganization).mockRejectedValueOnce(
        new Error("Clerk API unavailable"),
      );

      const newSlug = `resilient-${Date.now()}`;

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

    it("should return user's default scope", async () => {
      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBeDefined();
      expect(data.slug).toBeDefined();
    });
  });

  describe("GET /api/scope (clerkOrgId resolution)", () => {
    it("should resolve scope by clerkOrgId from session", async () => {
      const userId = `clerk-org-test-${Date.now()}`;
      mockClerk({ userId });

      // Create first scope (becomes default)
      const slug1 = `first-org-${Date.now()}`;
      const req1 = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug1 }),
      });
      await POST(req1);

      // Create second scope
      const slug2 = `second-org-${Date.now()}`;
      const req2 = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug2 }),
      });
      await POST(req2);

      // Set active org to second scope's clerkOrgId, include both scope orgs
      mockClerk({
        userId,
        orgId: `org_mock_${slug2}`,
        clerkOrgs: [
          { id: `org_mock_${slug1}`, slug: slug1, name: slug1 },
          { id: `org_mock_${slug2}`, slug: slug2, name: slug2 },
        ],
      });

      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.slug).toBe(slug2);
    });

    it("should fall through to default when clerkOrgId has no matching scope", async () => {
      const userId = `no-match-org-${Date.now()}`;
      mockClerk({ userId });

      // Create a default scope
      const slug = `default-org-${Date.now()}`;
      const reqCreate = createTestRequest("http://localhost:3000/api/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      await POST(reqCreate);

      // Set an orgId that doesn't match any scope, but include the created scope org
      mockClerk({
        userId,
        orgId: "org_nonexistent_xyz",
        clerkOrgs: [{ id: `org_mock_${slug}`, slug, name: slug }],
      });

      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.slug).toBe(slug);
    });

    it("should work without orgId (CLI compatibility)", async () => {
      const userId = `no-org-${Date.now()}`;
      mockClerk({ userId });

      const request = createTestRequest("http://localhost:3000/api/scope");
      const response = await GET(request);
      const data = await response.json();

      // With Clerk configured, the user's default org is discovered via JIT
      // and its slug is used (mockClerk defaults to org-{userId} slug)
      expect(response.status).toBe(200);
      // JIT discovery uses Clerk org slug (org-{userId} from mock)
      expect(data.slug).toMatch(/^org-no-org-/);
    });
  });
});
