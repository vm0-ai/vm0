import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../../app/api/org/model-providers/route";
import { DELETE } from "../../app/api/org/model-providers/[type]/route";
import { POST as setDefaultRoute } from "../../app/api/org/model-providers/[type]/set-default/route";
import { PATCH as updateModelRoute } from "../../app/api/org/model-providers/[type]/model/route";
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

function orgUrl(path: string, slug: string): string {
  return `http://localhost:3000/api/org/model-providers${path}?org=${slug}`;
}

describe("Org model-provider API", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/org/model-providers", () => {
    it("should return empty list initially", async () => {
      const userId = uniqueId("omp-list");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelProviders).toEqual([]);
    });

    it("should allow member to list org providers", async () => {
      const userId = uniqueId("omp-member-list");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelProviders).toEqual([]);
    });

    it("should reject unauthenticated requests", async () => {
      mockClerk({ userId: null });

      const response = await GET(
        createTestRequest(
          "http://localhost:3000/api/org/model-providers?org=test",
        ),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("PUT /api/org/model-providers", () => {
    it("should create org provider as admin", async () => {
      const userId = uniqueId("omp-create");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
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
      expect(data.provider.isDefault).toBe(true);
      expect(data.created).toBe(true);
    });

    it("should update existing org provider", async () => {
      const userId = uniqueId("omp-update");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "key-v1",
          }),
        }),
      );

      // Update
      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
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
      const { slug } = await setupOrg(userId, "org:member");

      const response = await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
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

      const response = await PUT(
        createTestRequest(
          "http://localhost:3000/api/org/model-providers?org=test",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "anthropic-api-key",
              secret: "test-key",
            }),
          },
        ),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("DELETE /api/org/model-providers/:type", () => {
    it("should delete org provider as admin", async () => {
      const userId = uniqueId("omp-delete");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create first
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-key",
          }),
        }),
      );

      // Delete
      const response = await DELETE(
        createTestRequest(orgUrl("/anthropic-api-key", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);

      // Verify deletion
      const listRes = await GET(createTestRequest(orgUrl("", slug)));
      const listData = await listRes.json();
      expect(listData.modelProviders).toEqual([]);
    });

    it("should return 404 for non-existent provider", async () => {
      const userId = uniqueId("omp-del-404");
      const { slug } = await setupOrg(userId, "org:admin");

      const response = await DELETE(
        createTestRequest(orgUrl("/anthropic-api-key", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("omp-del-member");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await DELETE(
        createTestRequest(orgUrl("/anthropic-api-key", slug), {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/org/model-providers/:type/set-default", () => {
    it("should set org provider as default", async () => {
      const userId = uniqueId("omp-default");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create two providers
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "key-1",
          }),
        }),
      );
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "claude-code-oauth-token",
            secret: "token-1",
          }),
        }),
      );

      // Set second as default
      const response = await setDefaultRoute(
        createTestRequest(
          orgUrl("/claude-code-oauth-token/set-default", slug),
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.isDefault).toBe(true);
      expect(data.type).toBe("claude-code-oauth-token");

      // Verify first is no longer default
      const listRes = await GET(createTestRequest(orgUrl("", slug)));
      const listData = await listRes.json();
      const anthropic = listData.modelProviders.find(
        (p: { type: string }) => p.type === "anthropic-api-key",
      );
      expect(anthropic).toBeDefined();
      expect(anthropic.isDefault).toBe(false);
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("omp-def-member");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await setDefaultRoute(
        createTestRequest(orgUrl("/anthropic-api-key/set-default", slug), {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("PATCH /api/org/model-providers/:type/model", () => {
    it("should update model selection", async () => {
      const userId = uniqueId("omp-model");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create provider with model
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "moonshot-api-key",
            secret: "test-key",
            selectedModel: "kimi-k2.5",
          }),
        }),
      );

      // Update model
      const response = await updateModelRoute(
        createTestRequest(orgUrl("/moonshot-api-key/model", slug), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedModel: "kimi-k2-thinking",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.selectedModel).toBe("kimi-k2-thinking");
    });

    it("should return 403 for non-admin member", async () => {
      const userId = uniqueId("omp-mod-member");
      const { slug } = await setupOrg(userId, "org:member");

      const response = await updateModelRoute(
        createTestRequest(orgUrl("/anthropic-api-key/model", slug), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectedModel: "some-model" }),
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("list after CRUD operations", () => {
    it("should list created org providers", async () => {
      const userId = uniqueId("omp-listcrud");
      const { slug } = await setupOrg(userId, "org:admin");

      // Create a provider
      await PUT(
        createTestRequest(orgUrl("", slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "anthropic-api-key",
            secret: "test-key",
          }),
        }),
      );

      const response = await GET(createTestRequest(orgUrl("", slug)));
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.modelProviders).toHaveLength(1);
      expect(data.modelProviders[0].type).toBe("anthropic-api-key");
      expect(data.modelProviders[0].framework).toBe("claude-code");
      expect(data.modelProviders[0].secretName).toBe("ANTHROPIC_API_KEY");
      expect(data.modelProviders[0].isDefault).toBe(true);
      expect(data.modelProviders[0].id).toBeDefined();
      expect(data.modelProviders[0].createdAt).toBeDefined();
      expect(data.modelProviders[0].updatedAt).toBeDefined();
    });
  });
});
