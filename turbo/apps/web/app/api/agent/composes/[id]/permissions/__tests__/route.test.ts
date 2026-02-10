import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST, DELETE } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("Permission Management API", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  describe("GET /api/agent/composes/:id/permissions - List Permissions", () => {
    it("should return empty array for compose with no permissions", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        { method: "GET" },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.permissions).toEqual([]);
    });

    it("should list all permissions for compose", async () => {
      // Add a public permission first
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );
      await POST(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // List permissions
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        { method: "GET" },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.permissions).toHaveLength(1);
      expect(data.permissions[0].granteeType).toBe("public");
    });

    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        { method: "GET" },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toBe("Unauthorized");
    });

    it("should return 404 for non-existent compose", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${fakeId}/permissions`,
        { method: "GET" },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: fakeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should return 403 for compose owned by another user", async () => {
      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        { method: "GET" },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("owner");
    });
  });

  describe("POST /api/agent/composes/:id/permissions - Add Permission", () => {
    it("should add public permission", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );

      const response = await POST(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });

    it("should add email permission", async () => {
      const email = "test@example.com";
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "email", granteeEmail: email }),
        },
      );

      const response = await POST(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });

    it("should return 400 when email permission is missing granteeEmail", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "email" }),
        },
      );

      const response = await POST(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("email");
    });

    it("should return 409 for duplicate email permission", async () => {
      const email = "duplicate@example.com";

      // Add permission first time
      const request1 = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "email", granteeEmail: email }),
        },
      );
      await POST(request1, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Try to add same permission again
      const request2 = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "email", granteeEmail: email }),
        },
      );
      const response = await POST(request2, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.message).toContain("already exists");
    });

    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );

      const response = await POST(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toBe("Unauthorized");
    });

    it("should return 403 for compose owned by another user", async () => {
      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );

      const response = await POST(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("owner");
    });
  });

  describe("DELETE /api/agent/composes/:id/permissions - Remove Permission", () => {
    it("should remove public permission", async () => {
      // Add permission first
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );
      await POST(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Remove permission
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions?type=public`,
        { method: "DELETE" },
      );

      const response = await DELETE(request, {
        params: Promise.resolve({ id: testComposeId }),
      });

      expect(response.status).toBe(204);

      // Verify permission is gone
      const listRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        { method: "GET" },
      );
      const listResponse = await GET(listRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const listData = await listResponse.json();

      expect(listData.permissions).toHaveLength(0);
    });

    it("should remove email permission", async () => {
      const email = "test@example.com";

      // Add permission first
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "email", granteeEmail: email }),
        },
      );
      await POST(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Remove permission
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions?type=email&email=${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );

      const response = await DELETE(request, {
        params: Promise.resolve({ id: testComposeId }),
      });

      expect(response.status).toBe(204);
    });

    it("should return 404 when permission does not exist", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions?type=public`,
        { method: "DELETE" },
      );

      const response = await DELETE(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should return 400 when type is missing", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        { method: "DELETE" },
      );

      const response = await DELETE(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("type");
    });

    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions?type=public`,
        { method: "DELETE" },
      );

      const response = await DELETE(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toBe("Unauthorized");
    });

    it("should return 403 for compose owned by another user", async () => {
      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions?type=public`,
        { method: "DELETE" },
      );

      const response = await DELETE(request, {
        params: Promise.resolve({ id: testComposeId }),
      });
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain("owner");
    });
  });
});
