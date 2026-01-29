import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

// Only mock external services
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/webhooks/agent/heartbeat", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose via API
    const { composeId } = await createTestCompose(
      `agent-heartbeat-${Date.now()}`,
    );
    testComposeId = composeId;

    // Create test run via API (status automatically set to running)
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(user.userId, testRunId);

    // Reset auth mock for webhook tests (which use token auth)
    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject heartbeat without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: testRunId }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should reject heartbeat without runId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });
  });

  describe("Authorization", () => {
    it("should reject heartbeat for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      // Generate JWT with the non-existent runId
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
          },
          body: JSON.stringify({ runId: nonExistentRunId }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject heartbeat for run owned by different user", async () => {
      // Create another user and their compose/run
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-agent-heartbeat-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other user prompt",
      );

      // Generate token for original user but try to access other user's run
      const tokenForOtherRun = await createTestSandboxToken(
        user.userId,
        otherRunId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForOtherRun}`,
          },
          body: JSON.stringify({ runId: otherRunId }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("Success", () => {
    it("should update lastHeartbeatAt for valid heartbeat", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({ runId: testRunId }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("should handle multiple consecutive heartbeats", async () => {
      // First heartbeat
      const request1 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({ runId: testRunId }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second heartbeat
      const request2 = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/heartbeat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({ runId: testRunId }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);

      // Both heartbeats should succeed
      const data1 = await response1.json();
      const data2 = await response2.json();
      expect(data1.ok).toBe(true);
      expect(data2.ok).toBe(true);
    });
  });
});
