import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../../app/api/org/variables/route";
import { DELETE } from "../../app/api/org/variables/[name]/route";
import { createTestRequest, createTestOrg } from "./api-test-helpers";
import { testContext, uniqueId } from "./test-helpers";
import { mockClerk } from "./clerk-mock";

const context = testContext();

/**
 * Setup an org with the given user as admin or member.
 */
async function setupOrg(userId: string, role: "org:admin" | "org:member") {
  const slug = uniqueId("orgvar");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: role });
  await createTestOrg(slug);

  return { slug, orgId };
}

function orgUrl(path: string, slug: string): string {
  return `http://localhost:3000/api/org/variables${path}?org=${slug}`;
}

describe("Org variables API", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/org/variables", () => {
    it("should return empty list initially", async () => {
      const userId = uniqueId("ov-list");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.variables).toEqual([]);
    });

    it("should allow member to list org variables", async () => {
      const userId = uniqueId("ov-member-list");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.variables).toEqual([]);
    });

    it("should reject unauthenticated requests", async () => {
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest("http://localhost:3000/api/org/variables?org=test"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("PUT /api/org/variables", () => {
    it("should create org variable as admin", async () => {
      const userId = uniqueId("ov-create");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_API_URL",
            value: "https://api.example.com",
            description: "Test org variable",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe("ORG_API_URL");
      expect(data.value).toBe("https://api.example.com");
      expect(data.description).toBe("Test org variable");
      expect(data.id).toBeDefined();
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it("should update existing org variable", async () => {
      const userId = uniqueId("ov-update");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_VAR_V",
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
            name: "ORG_VAR_V",
            value: "value-v2",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe("ORG_VAR_V");
      expect(data.value).toBe("value-v2");
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("ov-member-put");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_VAR",
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
        createTestRequest("http://localhost:3000/api/org/variables?org=test", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_VAR",
            value: "test-value",
          }),
        }),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("DELETE /api/org/variables/:name", () => {
    it("should delete org variable as admin", async () => {
      const userId = uniqueId("ov-delete");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create first
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_DELETE_VAR",
            value: "delete-this",
          }),
        }),
      );

      // Delete
      const response = await DELETE(
        createTestRequest(orgUrl("/ORG_DELETE_VAR", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);

      // Verify deletion
      const listRes = await GET(createTestRequest(orgUrl("", slug)));
      const listData = await listRes.json();
      expect(listData.variables).toEqual([]);
    });

    it("should return 404 for non-existent variable", async () => {
      const userId = uniqueId("ov-del-404");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await DELETE(
        createTestRequest(orgUrl("/NONEXISTENT", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("ov-del-member");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await DELETE(
        createTestRequest(orgUrl("/SOME_VAR", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("list after CRUD operations", () => {
    it("should list created org variables", async () => {
      const userId = uniqueId("ov-listcrud");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create a variable
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ORG_LISTED_VAR",
            value: "listed-value",
            description: "A listed variable",
          }),
        }),
      );

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.variables).toHaveLength(1);
      expect(data.variables[0].name).toBe("ORG_LISTED_VAR");
      expect(data.variables[0].value).toBe("listed-value");
      expect(data.variables[0].description).toBe("A listed variable");
      expect(data.variables[0].id).toBeDefined();
      expect(data.variables[0].createdAt).toBeDefined();
      expect(data.variables[0].updatedAt).toBeDefined();
    });
  });
});
