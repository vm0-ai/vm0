import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../../app/api/org/secrets/route";
import { DELETE } from "../../app/api/org/secrets/[name]/route";
import { createTestRequest, createTestOrg } from "./api-test-helpers";
import { testContext, uniqueId } from "./test-helpers";
import { mockClerk } from "./clerk-mock";

const context = testContext();

/**
 * Setup an org with the given user as admin or member.
 */
async function setupOrg(userId: string, role: "org:admin" | "org:member") {
  const slug = uniqueId("orgsec");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: role });
  await createTestOrg(slug);

  return { slug, orgId };
}

function orgUrl(path: string, slug: string): string {
  return `http://localhost:3000/api/org/secrets${path}?org=${slug}`;
}

describe("Org secrets API", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/org/secrets", () => {
    it("should return empty list initially", async () => {
      const userId = uniqueId("os-list");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.secrets).toEqual([]);
    });

    it("should allow member to list org secrets", async () => {
      const userId = uniqueId("os-member-list");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.secrets).toEqual([]);
    });

    it("should reject unauthenticated requests", async () => {
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest("http://localhost:3000/api/org/secrets?org=test"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("PUT /api/org/secrets", () => {
    it("should create org secret as admin", async () => {
      const userId = uniqueId("os-create");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_API_KEY",
            value: "test-org-secret-value",
            description: "Test org secret",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe("ORG_API_KEY");
      expect(data.description).toBe("Test org secret");
      expect(data.type).toBe("user");
      expect(data.id).toBeDefined();
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it("should update existing org secret", async () => {
      const userId = uniqueId("os-update");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_SECRET_V",
            value: "value-v1",
          }),
        }),
      );

      // Update
      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_SECRET_V",
            value: "value-v2",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe("ORG_SECRET_V");
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("os-member-put");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_SECRET",
            value: "test-value",
          }),
        }),
      );
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 401 for unauthenticated", async () => {
      mockClerk({ userId: null });

      const response = await PUT(
        createTestRequest("http://localhost:3000/api/org/secrets?org=test", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_SECRET",
            value: "test-value",
          }),
        }),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("DELETE /api/org/secrets/:name", () => {
    it("should delete org secret as admin", async () => {
      const userId = uniqueId("os-delete");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create first
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_DELETE_ME",
            value: "delete-this",
          }),
        }),
      );

      // Delete
      const response = await DELETE(
        createTestRequest(orgUrl("/ORG_DELETE_ME", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);

      // Verify deletion
      const listRes = await GET(createTestRequest(orgUrl("", slug)));
      const listData = await listRes.json();
      expect(listData.secrets).toEqual([]);
    });

    it("should return 404 for non-existent secret", async () => {
      const userId = uniqueId("os-del-404");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await DELETE(
        createTestRequest(orgUrl("/NONEXISTENT", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("os-del-member");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await DELETE(
        createTestRequest(orgUrl("/SOME_SECRET", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("list after CRUD operations", () => {
    it("should list created org secrets", async () => {
      const userId = uniqueId("os-listcrud");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create a secret
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_LISTED_SECRET",
            value: "listed-value",
            description: "A listed secret",
          }),
        }),
      );

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.secrets).toHaveLength(1);
      expect(data.secrets[0].name).toBe("ORG_LISTED_SECRET");
      expect(data.secrets[0].description).toBe("A listed secret");
      expect(data.secrets[0].type).toBe("user");
      expect(data.secrets[0].id).toBeDefined();
      expect(data.secrets[0].createdAt).toBeDefined();
      expect(data.secrets[0].updatedAt).toBeDefined();
    });
  });
});
