import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestCreditUsagesByRunId,
  findTestUsageEventsByRunId,
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
import {
  MODEL_USAGE_KIND,
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
} from "../../../../../../src/lib/zero/billing/model-usage-categories";

const context = testContext();

describe("POST /api/webhooks/agent/usage", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;

  const url = "http://localhost:3000/api/webhooks/agent/usage";

  function makeRequest(body: Record<string, unknown>, token = testToken) {
    return createTestRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function expectNoLegacyCreditUsage(runId = testRunId) {
    expect(await findTestCreditUsagesByRunId(runId)).toHaveLength(0);
  }

  function quantitiesByCategory(
    rows: Awaited<ReturnType<typeof findTestUsageEventsByRunId>>,
  ) {
    return Object.fromEntries(
      rows.map((row) => {
        return [row.category, row.quantity];
      }),
    );
  }

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

  // ── Happy path: write to usage_event ───────────────────────────────

  describe("Write path", () => {
    it("inserts one pending usage_event per positive token class", async () => {
      const response = await POST(
        makeRequest({
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
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: MODEL_USAGE_KIND,
            provider: "claude-sonnet-4-6",
            category: TOKEN_CATEGORY_INPUT,
            quantity: 1000,
            status: "pending",
          }),
          expect.objectContaining({
            kind: MODEL_USAGE_KIND,
            provider: "claude-sonnet-4-6",
            category: TOKEN_CATEGORY_OUTPUT,
            quantity: 500,
            status: "pending",
          }),
          expect.objectContaining({
            kind: MODEL_USAGE_KIND,
            provider: "claude-sonnet-4-6",
            category: TOKEN_CATEGORY_CACHE_READ,
            quantity: 300,
            status: "pending",
          }),
          expect.objectContaining({
            kind: MODEL_USAGE_KIND,
            provider: "claude-sonnet-4-6",
            category: TOKEN_CATEGORY_CACHE_CREATION,
            quantity: 200,
            status: "pending",
          }),
        ]),
      );
      await expectNoLegacyCreditUsage();
    });

    it("skips zero and missing token classes", async () => {
      const response = await POST(
        makeRequest({
          runId: testRunId,
          usage: {
            model: "claude-sonnet-4-6",
            message_id: "msg_sparse",
            input_tokens: 100,
            output_tokens: 0,
            cache_creation_input_tokens: 200,
          },
        }),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(2);
      expect(quantitiesByCategory(rows)).toEqual({
        [TOKEN_CATEGORY_CACHE_CREATION]: 200,
        [TOKEN_CATEGORY_INPUT]: 100,
      });
      await expectNoLegacyCreditUsage();
    });

    it("deduplicates by deterministic per-category idempotencyKey on retry", async () => {
      const body = {
        runId: testRunId,
        usage: {
          model: "claude-sonnet-4-6",
          message_id: "msg_dup",
          input_tokens: 1000,
          output_tokens: 500,
        },
      };

      expect((await POST(makeRequest(body))).status).toBe(200);
      expect((await POST(makeRequest(body))).status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(2);
      expect(quantitiesByCategory(rows)).toEqual({
        [TOKEN_CATEGORY_INPUT]: 1000,
        [TOKEN_CATEGORY_OUTPUT]: 500,
      });
      await expectNoLegacyCreditUsage();
    });

    it("keeps the first value when a duplicate category arrives with a different quantity", async () => {
      const firstBody = {
        runId: testRunId,
        usage: {
          model: "claude-sonnet-4-6",
          message_id: "msg_dup_changed",
          input_tokens: 1000,
        },
      };
      const secondBody = {
        runId: testRunId,
        usage: {
          model: "claude-sonnet-4-6",
          message_id: "msg_dup_changed",
          input_tokens: 9999,
        },
      };

      expect((await POST(makeRequest(firstBody))).status).toBe(200);
      expect((await POST(makeRequest(secondBody))).status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(1000);
    });

    it("writes separate events for the same run with different messageIds", async () => {
      const makeBody = (messageId: string, inputTokens: number) => {
        return {
          runId: testRunId,
          usage: {
            model: "claude-sonnet-4-6",
            message_id: messageId,
            input_tokens: inputTokens,
          },
        };
      };

      expect((await POST(makeRequest(makeBody("msg_main", 100)))).status).toBe(
        200,
      );
      expect((await POST(makeRequest(makeBody("msg_sub1", 200)))).status).toBe(
        200,
      );
      expect((await POST(makeRequest(makeBody("msg_sub2", 300)))).status).toBe(
        200,
      );

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(3);
      const total = rows.reduce((acc, r) => {
        return acc + r.quantity;
      }, 0);
      expect(total).toBe(600);
      await expectNoLegacyCreditUsage();
    });

    it("does not deduplicate the same message_id across different runs", async () => {
      const { runId: secondRunId } = await seedTestRun(
        user.userId,
        testComposeId,
      );
      const secondToken = await createTestSandboxToken(
        user.userId,
        secondRunId,
      );
      const makeBody = (runId: string, inputTokens: number) => {
        return {
          runId,
          usage: {
            model: "claude-sonnet-4-6",
            message_id: "msg_shared_across_runs",
            input_tokens: inputTokens,
          },
        };
      };

      expect((await POST(makeRequest(makeBody(testRunId, 100)))).status).toBe(
        200,
      );
      expect(
        (await POST(makeRequest(makeBody(secondRunId, 200), secondToken)))
          .status,
      ).toBe(200);

      const firstRows = await findTestUsageEventsByRunId(testRunId);
      expect(firstRows).toHaveLength(1);
      expect(firstRows[0]!.quantity).toBe(100);

      const secondRows = await findTestUsageEventsByRunId(secondRunId);
      expect(secondRows).toHaveLength(1);
      expect(secondRows[0]!.quantity).toBe(200);
      await expectNoLegacyCreditUsage();
      await expectNoLegacyCreditUsage(secondRunId);
    });

    it.each([
      { name: "omitted", usage: { model: "claude-sonnet-4-6" } },
      {
        name: "empty",
        usage: { model: "claude-sonnet-4-6", message_id: "" },
      },
    ])(
      "rejects positive token usage with $name message_id",
      async ({ usage }) => {
        const response = await POST(
          makeRequest({
            runId: testRunId,
            usage: { ...usage, input_tokens: 100 },
          }),
        );
        expect(response.status).toBe(400);

        const rows = await findTestUsageEventsByRunId(testRunId);
        expect(rows).toHaveLength(0);
        await expectNoLegacyCreditUsage();
      },
    );

    it("accepts usage with no positive token quantities without writing rows", async () => {
      const response = await POST(
        makeRequest({
          runId: testRunId,
          usage: {
            model: "claude-sonnet-4-6",
            web_search_requests: 1,
          },
        }),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(0);
      await expectNoLegacyCreditUsage();
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

      const response = await POST(
        makeRequest(
          {
            runId: zeroRunId,
            usage: {
              model: "claude-sonnet-4-6",
              message_id: "msg_prec",
              input_tokens: 10,
            },
          },
          token,
        ),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(zeroRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe("claude-opus-4-1");
      await expectNoLegacyCreditUsage(zeroRunId);
    });

    it("falls back to u.model when selectedModel not set", async () => {
      const response = await POST(
        makeRequest({
          runId: testRunId,
          usage: {
            model: "claude-sonnet-4-6",
            message_id: "msg_fallback",
            input_tokens: 10,
          },
        }),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe("claude-sonnet-4-6");
      await expectNoLegacyCreditUsage();
    });

    it("uses 'unknown' when neither selectedModel nor u.model is set", async () => {
      const response = await POST(
        makeRequest({
          runId: testRunId,
          usage: { message_id: "msg_unknown", input_tokens: 10 },
        }),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe("unknown");
      await expectNoLegacyCreditUsage();
    });
  });
});
