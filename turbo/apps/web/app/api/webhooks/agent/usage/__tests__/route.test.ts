import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestCreditUsagesByRunId,
  setTestRunModelProvider,
  setTestRunSelectedModel,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

describe("POST /api/webhooks/agent/usage", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent-usage"));
    testComposeId = composeId;

    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    testToken = await createTestSandboxToken(user.userId, testRunId);

    mockClerk({ userId: null });
  });

  // ── Authentication ─────────────────────────────────────────────────

  describe("Authentication", () => {
    it("rejects webhook without auth", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: testRunId,
            usage: { model: "claude-sonnet-4-6", input_tokens: 10 },
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("rejects webhook with token for a different run", async () => {
      const otherRunId = randomUUID();
      const badToken = await createTestSandboxToken(user.userId, otherRunId);
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${badToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            usage: { model: "claude-sonnet-4-6", input_tokens: 10 },
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("returns 404 for run that does not exist", async () => {
      const missingRunId = randomUUID();
      const token = await createTestSandboxToken(user.userId, missingRunId);
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId: missingRunId,
            usage: { model: "claude-sonnet-4-6", input_tokens: 10 },
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(404);
    });
  });

  // ── Happy path: write to credit_usage ──────────────────────────────

  describe("Write path", () => {
    it("inserts a row into credit_usage with status='pending'", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            usage: {
              model: "claude-sonnet-4-6",
              message_id: "msg_happy",
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 200,
              web_search_requests: 1,
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const rows = await findTestCreditUsagesByRunId(testRunId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("pending");
      expect(row.inputTokens).toBe(1000);
      expect(row.outputTokens).toBe(500);
      expect(row.cacheReadInputTokens).toBe(300);
      expect(row.cacheCreationInputTokens).toBe(200);
      expect(row.webSearchRequests).toBe(1);
    });

    it("deduplicates by (runId, messageId) on retry", async () => {
      const payload = JSON.stringify({
        runId: testRunId,
        usage: {
          model: "claude-sonnet-4-6",
          message_id: "msg_dup",
          input_tokens: 1000,
        },
      });
      const makeReq = () => {
        return createTestRequest(
          "http://localhost:3000/api/webhooks/agent/usage",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${testToken}`,
            },
            body: payload,
          },
        );
      };

      expect((await POST(makeReq())).status).toBe(200);
      expect((await POST(makeReq())).status).toBe(200);

      const rows = await findTestCreditUsagesByRunId(testRunId);
      expect(rows).toHaveLength(1);
    });

    it("writes separate rows for the same run with different messageIds", async () => {
      const makeReq = (messageId: string, inputTokens: number) => {
        return createTestRequest(
          "http://localhost:3000/api/webhooks/agent/usage",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${testToken}`,
            },
            body: JSON.stringify({
              runId: testRunId,
              usage: {
                model: "claude-sonnet-4-6",
                message_id: messageId,
                input_tokens: inputTokens,
              },
            }),
          },
        );
      };

      expect((await POST(makeReq("msg_main", 100))).status).toBe(200);
      expect((await POST(makeReq("msg_sub1", 200))).status).toBe(200);
      expect((await POST(makeReq("msg_sub2", 300))).status).toBe(200);

      const rows = await findTestCreditUsagesByRunId(testRunId);
      expect(rows).toHaveLength(3);
      const total = rows.reduce((acc, r) => {
        return acc + r.inputTokens;
      }, 0);
      expect(total).toBe(600);
    });
  });

  // ── Model precedence ───────────────────────────────────────────────

  describe("Model precedence", () => {
    it("prefers run.selectedModel over u.model", async () => {
      const { runId: zeroRunId } = await seedTestRun(
        user.userId,
        testComposeId,
      );
      await setTestRunModelProvider(zeroRunId, "anthropic-api-key");
      await setTestRunSelectedModel(zeroRunId, "claude-opus-4-1");
      const token = await createTestSandboxToken(user.userId, zeroRunId);

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            runId: zeroRunId,
            usage: {
              model: "claude-sonnet-4-6",
              message_id: "msg_prec",
              input_tokens: 10,
            },
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const rows = await findTestCreditUsagesByRunId(zeroRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe("claude-opus-4-1");
      expect(rows[0]!.modelProvider).toBe("anthropic-api-key");
    });

    it("falls back to u.model when selectedModel not set", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            usage: {
              model: "claude-sonnet-4-6",
              message_id: "msg_fallback",
              input_tokens: 10,
            },
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const rows = await findTestCreditUsagesByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe("claude-sonnet-4-6");
    });

    it("uses 'unknown' when neither selectedModel nor u.model is set", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/usage",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            usage: { message_id: "msg_unknown", input_tokens: 10 },
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      const rows = await findTestCreditUsagesByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe("unknown");
    });
  });
});
