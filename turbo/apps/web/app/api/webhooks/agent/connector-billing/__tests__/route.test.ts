import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestConnectorBillingByRunId,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";

const context = testContext();

describe("POST /api/webhooks/agent/connector-billing", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  const url = "http://localhost:3000/api/webhooks/agent/connector-billing";

  function makeRequest(body: Record<string, unknown>, token?: string) {
    return createTestRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  const validBody = () => {
    return {
      runId: testRunId,
      flowId: "flow-abc-123",
      connector: "x",
      category: "tweet.read",
      quantity: 5,
    };
  };

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      uniqueId("connector-billing"),
    );
    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
    testToken = await createTestSandboxToken(user.userId, testRunId);

    mockClerk({ userId: null });
  });

  // ── Authentication ─────────────────────────────────────────────────

  describe("Authentication", () => {
    it("rejects webhook without auth", async () => {
      const response = await POST(makeRequest(validBody()));
      expect(response.status).toBe(401);
    });

    it("rejects webhook with token for a different run", async () => {
      const badToken = await createTestSandboxToken(user.userId, randomUUID());
      const response = await POST(makeRequest(validBody(), badToken));
      expect(response.status).toBe(401);
    });

    it("returns 404 for run that does not exist", async () => {
      const missingRunId = randomUUID();
      const token = await createTestSandboxToken(user.userId, missingRunId);
      const response = await POST(
        makeRequest({ ...validBody(), runId: missingRunId }, token),
      );
      expect(response.status).toBe(404);
    });
  });

  // ── Write path ─────────────────────────────────────────────────────

  describe("Write path", () => {
    it("inserts a row with status='pending'", async () => {
      const response = await POST(makeRequest(validBody(), testToken));
      expect(response.status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("pending");
      expect(row.connector).toBe("x");
      expect(row.category).toBe("tweet.read");
      expect(row.quantity).toBe(5);
      expect(row.flowId).toBe("flow-abc-123");
    });

    it("deduplicates by (runId, flowId, category) on retry", async () => {
      const body = validBody();
      expect((await POST(makeRequest(body, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
    });

    it("keeps first value when duplicate arrives with different quantity", async () => {
      const body1 = { ...validBody(), quantity: 5 };
      const body2 = { ...validBody(), quantity: 99 };

      expect((await POST(makeRequest(body1, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body2, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(5);
    });

    it("writes separate rows for different categories", async () => {
      const body1 = { ...validBody(), category: "tweet.read", quantity: 3 };
      const body2 = { ...validBody(), category: "users.read", quantity: 2 };

      expect((await POST(makeRequest(body1, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body2, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(2);
      const byCategory = Object.fromEntries(
        rows.map((r) => {
          return [r.category, r.quantity];
        }),
      );
      expect(byCategory["tweet.read"]).toBe(3);
      expect(byCategory["users.read"]).toBe(2);
    });

    it("writes separate rows for different flowIds", async () => {
      const body1 = { ...validBody(), flowId: "flow-1" };
      const body2 = { ...validBody(), flowId: "flow-2" };

      expect((await POST(makeRequest(body1, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body2, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(2);
    });

    it("accepts quantity=0", async () => {
      const body = { ...validBody(), quantity: 0 };
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(0);
    });
  });

  // ── Validation ─────────────────────────────────────────────────────

  describe("Validation", () => {
    it("rejects negative quantity", async () => {
      const body = { ...validBody(), quantity: -1 };
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it("rejects empty connector", async () => {
      const body = { ...validBody(), connector: "" };
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it("rejects empty category", async () => {
      const body = { ...validBody(), category: "" };
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it("rejects missing runId", async () => {
      const { runId: _, ...body } = validBody();
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });
  });
});
