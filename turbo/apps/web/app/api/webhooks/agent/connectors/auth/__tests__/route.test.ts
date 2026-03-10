import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  createTestConnector,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

function makeRequest(body: Record<string, unknown>, token?: string): Request {
  return createTestRequest(
    "http://localhost:3000/api/webhooks/agent/connectors/auth",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/webhooks/agent/connectors/auth", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `agent-connector-token-${Date.now()}`,
    );
    testComposeId = composeId;

    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    testToken = await createTestSandboxToken(user.userId, testRunId);

    mockClerk({ userId: null });
  });

  describe("Authentication", () => {
    it("should reject without auth header", async () => {
      const response = await POST(
        makeRequest({
          runId: testRunId,
          connectorName: "github",
          base: "https://api.github.com",
        }),
      );
      expect(response.status).toBe(401);
    });

    it("should reject with invalid token", async () => {
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            connectorName: "github",
            base: "https://api.github.com",
          },
          "invalid-token",
        ),
      );
      expect(response.status).toBe(401);
    });

    it("should reject with mismatched runId", async () => {
      const otherRunId = randomUUID();
      const response = await POST(
        makeRequest(
          {
            runId: otherRunId,
            connectorName: "github",
            base: "https://api.github.com",
          },
          testToken,
        ),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("Validation", () => {
    it("should reject without runId", async () => {
      const response = await POST(
        makeRequest(
          { connectorName: "github", base: "https://api.github.com" },
          testToken,
        ),
      );
      expect(response.status).toBe(400);
    });

    it("should reject without connectorName", async () => {
      const response = await POST(
        makeRequest(
          { runId: testRunId, base: "https://api.github.com" },
          testToken,
        ),
      );
      expect(response.status).toBe(400);
    });

    it("should reject unknown connector type", async () => {
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            connectorName: "not-a-connector",
            base: "https://example.com",
          },
          testToken,
        ),
      );
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("Unknown connector type");
    });
  });

  describe("Connector not connected", () => {
    it("should return 404 when connector is not connected", async () => {
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            connectorName: "github",
            base: "https://api.github.com",
          },
          testToken,
        ),
      );
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("not connected");
    });
  });

  describe("Success", () => {
    it("should return resolved auth headers for connected connector", async () => {
      // Restore Clerk auth for connector creation (OAuth callback requires auth)
      mockClerk({ userId: user.userId });
      await createTestConnector(user.scopeId, {
        type: "github",
        accessToken: "ghp_test_access_token_123",
      });
      mockClerk({ userId: null });

      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            connectorName: "github",
            base: "https://api.github.com",
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers).toEqual({
        Authorization: "Bearer ghp_test_access_token_123",
      });
      expect(data.expiresIn).toBe(3600);
    });

    it("should return headers for different connector types", async () => {
      mockClerk({ userId: user.userId });
      await createTestConnector(user.scopeId, {
        type: "slack",
        accessToken: "xoxb-test-slack-token",
      });
      mockClerk({ userId: null });

      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            connectorName: "slack",
            base: "https://slack.com/api",
          },
          testToken,
        ),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.headers.Authorization).toBe("Bearer xoxb-test-slack-token");
    });
  });

  describe("Authorization", () => {
    it("should reject run owned by different user", async () => {
      const otherUser = await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-connector-${Date.now()}`,
      );
      const { runId: otherRunId } = await createTestRun(
        otherComposeId,
        "Other prompt",
      );

      mockClerk({ userId: otherUser.userId });
      await createTestConnector(otherUser.scopeId, {
        type: "github",
        accessToken: "ghp_other_user_token",
      });
      mockClerk({ userId: null });

      const tokenForOtherRun = await createTestSandboxToken(
        user.userId,
        otherRunId,
      );

      const response = await POST(
        makeRequest(
          {
            runId: otherRunId,
            connectorName: "github",
            base: "https://api.github.com",
          },
          tokenForOtherRun,
        ),
      );

      // Should fail: token userId doesn't match run's userId
      expect(response.status).toBe(404);
    });
  });
});
