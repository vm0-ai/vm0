import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/agent/runs/:id - Get Run By ID", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  describe("Successful Retrieval", () => {
    it("should return run details with all expected fields", async () => {
      const run = await createTestRun(testComposeId, "Test prompt");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.runId).toBe(run.runId);
      expect(data.prompt).toBe("Test prompt");
      expect(data.status).toBe("running");
      expect(data.completedAt).toBeUndefined();
      expect(data).toHaveProperty("agentComposeVersionId");
      expect(data).toHaveProperty("createdAt");
    });

    it("should return completed run with result", async () => {
      const run = await createTestRun(testComposeId, "Run to complete");

      // Complete the run
      await completeTestRun(user.userId, run.runId);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("completed");
      expect(data.completedAt).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const run = await createTestRun(testComposeId, "Test run");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${fakeId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });

    it("should return 404 for run belonging to another user", async () => {
      // Create another user and their run
      const otherUser = await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        uniqueId("other-agent"),
      );

      // Create run as other user
      mockClerk({ userId: otherUser.userId });
      const otherRun = await createTestRun(otherComposeId, "Other user run");

      // Switch back to original user and try to access other user's run
      mockClerk({ userId: user.userId });
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRun.runId}`,
      );

      const response = await GET(request);
      const data = await response.json();

      // Should return 404 to avoid leaking existence of other user's run
      expect(response.status).toBe(404);
      expect(data.error.message).toContain("not found");
    });
  });
});
