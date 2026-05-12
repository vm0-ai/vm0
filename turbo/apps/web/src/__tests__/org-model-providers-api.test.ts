import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../../app/api/zero/model-providers/route";
import { DELETE } from "../../app/api/zero/model-providers/[type]/route";
import { createTestRequest, createTestOrg } from "./api-test-helpers";
import { testContext, uniqueId } from "./test-helpers";
import { mockClerk } from "./clerk-mock";

const context = testContext();

/**
 * Setup an org with the given user as admin or member.
 * Uses mockClerk directly with orgRole so resolveOrg JWT fast path
 * returns the correct role.
 */
async function setupOrg(userId: string, role: "org:admin" | "org:member") {
  const slug = uniqueId("orgmp");
  const orgId = `org_mock_${userId}`;

  mockClerk({ userId, orgId, orgRole: role });
  await createTestOrg(slug);

  return { slug, orgId };
}

function orgUrl(path: string): string {
  return `http://localhost:3000/api/zero/model-providers${path}`;
}

describe("Org model-provider API", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/zero/model-providers", () => {
    it("should return empty list initially", async () => {
      const userId = uniqueId("omp-list");
      await setupOrg(userId, "org:admin");

      const response = await GET(createTestRequest(orgUrl("")));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelProviders).toEqual([]);
    });

    it("should allow member to list org providers", async () => {
      const userId = uniqueId("omp-member-list");
      await setupOrg(userId, "org:member");

      const response = await GET(createTestRequest(orgUrl("")));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelProviders).toEqual([]);
    });

    it("should reject unauthenticated requests", async () => {
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest("http://localhost:3000/api/zero/model-providers"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("POST /api/zero/model-providers", () => {
    it("should create org provider as admin", async () => {
      const userId = uniqueId("omp-create");
      await setupOrg(userId, "org:admin");

      const response = await POST(
        createTestRequest(orgUrl(""), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-org-key",
          }),
        }),
      );
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.provider.type).toBe("anthropic-api-key");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.isDefault).toBe(false);
      expect(data.created).toBe(true);
    });

    it("should update existing org provider", async () => {
      const userId = uniqueId("omp-update");
      await setupOrg(userId, "org:admin");

      // Create
      await POST(
        createTestRequest(orgUrl(""), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "key-v1",
          }),
        }),
      );

      // Update
      const response = await POST(
        createTestRequest(orgUrl(""), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "key-v2",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.created).toBe(false);
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("omp-member-put");
      await setupOrg(userId, "org:member");

      const response = await POST(
        createTestRequest(orgUrl(""), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-key",
          }),
        }),
      );
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("should return 401 for unauthenticated", async () => {
      mockClerk({ userId: null });

      const response = await POST(
        createTestRequest("http://localhost:3000/api/zero/model-providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-key",
          }),
        }),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("DELETE /api/zero/model-providers/:type", () => {
    it("should delete org provider as admin", async () => {
      const userId = uniqueId("omp-delete");
      await setupOrg(userId, "org:admin");

      // Create first
      await POST(
        createTestRequest(orgUrl(""), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-key",
          }),
        }),
      );

      // Delete
      const response = await DELETE(
        createTestRequest(orgUrl("/anthropic-api-key"), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);

      // Verify deletion
      const listRes = await GET(createTestRequest(orgUrl("")));
      const listData = await listRes.json();
      expect(listData.modelProviders).toEqual([]);
    });

    it("should return 404 for non-existent provider", async () => {
      const userId = uniqueId("omp-del-404");
      await setupOrg(userId, "org:admin");

      const response = await DELETE(
        createTestRequest(orgUrl("/anthropic-api-key"), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("omp-del-member");
      await setupOrg(userId, "org:member");

      const response = await DELETE(
        createTestRequest(orgUrl("/anthropic-api-key"), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("list after CRUD operations", () => {
    it("should list created org providers", async () => {
      const userId = uniqueId("omp-listcrud");
      await setupOrg(userId, "org:admin");

      // Create a provider
      await POST(
        createTestRequest(orgUrl(""), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-key",
          }),
        }),
      );

      const response = await GET(createTestRequest(orgUrl("")));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelProviders).toHaveLength(1);
      expect(data.modelProviders[0].type).toBe("anthropic-api-key");
      expect(data.modelProviders[0].framework).toBe("claude-code");
      expect(data.modelProviders[0].secretName).toBe("ANTHROPIC_API_KEY");
      expect(data.modelProviders[0].isDefault).toBe(false);
      expect(data.modelProviders[0].id).toBeDefined();
      expect(data.modelProviders[0].createdAt).toBeDefined();
      expect(data.modelProviders[0].updatedAt).toBeDefined();
    });
  });
});
