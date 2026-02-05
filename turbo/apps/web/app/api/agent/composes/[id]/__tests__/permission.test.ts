import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as getCompose } from "../route";
import { POST as addPermission } from "../permissions/route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("Agent Compose Permission Checks", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  describe("Cross-User Access Control", () => {
    // Note: API returns 404 (not 403) for unauthorized access to prevent
    // information leakage about existence of private agents
    it("should deny access to another user's private compose (returns 404)", async () => {
      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // API returns 404 instead of 403 for security (don't leak existence of private agents)
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should allow access when compose is public", async () => {
      // Make compose public (as owner)
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ granteeType: "public" }),
        },
      );
      await addPermission(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Switch to another user
      await context.setupUser({ prefix: "other-user" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should allow access when user email is in permission list", async () => {
      // Share with the default mock email (test@example.com)
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            granteeType: "email",
            granteeEmail: "test@example.com", // This is what mockClerk returns
          }),
        },
      );
      await addPermission(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Switch to another user (who has email test@example.com via mock)
      mockClerk({ userId: "other-user-123" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });

    it("should still deny access when email does not match (returns 404)", async () => {
      const sharedEmail = "different@example.com";

      // Share with different email (as owner)
      const addRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}/permissions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            granteeType: "email",
            granteeEmail: sharedEmail,
          }),
        },
      );
      await addPermission(addRequest, {
        params: Promise.resolve({ id: testComposeId }),
      });

      // Switch to another user (with test@example.com email - doesn't match)
      mockClerk({ userId: "other-user-123" });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      // API returns 404 instead of 403 for security
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should always allow owner to access their compose", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${testComposeId}`,
        { method: "GET" },
      );

      const response = await getCompose(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(testComposeId);
    });
  });
});
