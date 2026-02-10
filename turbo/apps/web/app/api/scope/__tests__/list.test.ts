import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../list/route";
import { POST as createScope } from "../route";
import { POST as createOrg } from "../../org/route";
import {
  createTestRequest,
  addTestOrgMember,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("/api/scope/list", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/scope/list", () => {
    it("should require authentication", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest("http://localhost:3000/api/scope/list");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return empty list for new user", async () => {
      mockClerk({ userId: `new-user-${Date.now()}` });

      const request = createTestRequest("http://localhost:3000/api/scope/list");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopes).toEqual([]);
    });

    it("should return personal scope only", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create personal scope
      const slug = `personal-${Date.now()}`;
      const createRequest = createTestRequest(
        "http://localhost:3000/api/scope",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        },
      );
      await createScope(createRequest);

      // List scopes
      const request = createTestRequest("http://localhost:3000/api/scope/list");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopes).toHaveLength(1);
      expect(data.scopes[0].slug).toBe(slug);
      expect(data.scopes[0].type).toBe("personal");
    });

    it("should return personal scope and organizations", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create personal scope
      const personalSlug = `personal-${Date.now()}`;
      const createScopeRequest = createTestRequest(
        "http://localhost:3000/api/scope",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: personalSlug }),
        },
      );
      await createScope(createScopeRequest);

      // Create organization (owned)
      const orgSlug = `org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      await createOrg(createOrgRequest);

      // List scopes
      const request = createTestRequest("http://localhost:3000/api/scope/list");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.scopes).toHaveLength(2);

      const personalScope = data.scopes.find(
        (s: { slug: string }) => s.slug === personalSlug,
      );
      const orgScope = data.scopes.find(
        (s: { slug: string }) => s.slug === orgSlug,
      );

      expect(personalScope).toBeDefined();
      expect(personalScope.type).toBe("personal");

      expect(orgScope).toBeDefined();
      expect(orgScope.type).toBe("organization");
      expect(orgScope.role).toBe("owner");
    });

    it("should return org membership for member", async () => {
      const ownerId = `owner-${Date.now()}`;
      const memberId = `member-${Date.now()}`;
      mockClerk({ userId: ownerId });

      // Owner creates organization
      const orgSlug = `org-${Date.now()}`;
      const createOrgRequest = createTestRequest(
        "http://localhost:3000/api/org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: orgSlug }),
        },
      );
      const createResponse = await createOrg(createOrgRequest);
      const org = await createResponse.json();

      // Add member
      await addTestOrgMember(org.id, memberId, "member");

      // List scopes as member
      mockClerk({ userId: memberId });
      const request = createTestRequest("http://localhost:3000/api/scope/list");
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      const orgScope = data.scopes.find(
        (s: { slug: string }) => s.slug === orgSlug,
      );
      expect(orgScope).toBeDefined();
      expect(orgScope.type).toBe("organization");
      expect(orgScope.role).toBe("member");
    });

    it("should include currentScope from header", async () => {
      const userId = `test-user-${Date.now()}`;
      mockClerk({ userId });

      // Create personal scope
      const slug = `personal-${Date.now()}`;
      const createRequest = createTestRequest(
        "http://localhost:3000/api/scope",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        },
      );
      await createScope(createRequest);

      // List scopes with current scope header
      const request = createTestRequest(
        "http://localhost:3000/api/scope/list",
        {
          headers: {
            "x-vm0-scope": slug,
          },
        },
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.currentScope).toBe(slug);
    });
  });
});
