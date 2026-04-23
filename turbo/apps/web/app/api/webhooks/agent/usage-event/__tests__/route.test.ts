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

describe("POST /api/webhooks/agent/usage-event", () => {
  let user: UserContext;
  let testRunId: string;
  let testToken: string;

  const url = "http://localhost:3000/api/webhooks/agent/usage-event";

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
      idempotencyKey: randomUUID(),
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 5,
    };
  };

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("usage-event"));
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

    it("returns 404 for run that does not exist (covers #10725 FK race)", async () => {
      // At the DB level this is indistinguishable from the #10725
      // aggregate-deletion race: the token is valid but the run row
      // referenced by `usage_event.runId` is not present, so the FK
      // raises SQLSTATE 23503 on INSERT. The handler surfaces it as
      // 404 rather than 500.
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
      expect(row.provider).toBe("x");
      expect(row.category).toBe("tweet.read");
      expect(row.quantity).toBe(5);
    });

    it("deduplicates by idempotencyKey on retry", async () => {
      const body = validBody();
      expect((await POST(makeRequest(body, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
    });

    it("keeps first value when duplicate arrives with different quantity", async () => {
      const sharedKey = randomUUID();
      const body1 = { ...validBody(), idempotencyKey: sharedKey, quantity: 5 };
      const body2 = { ...validBody(), idempotencyKey: sharedKey, quantity: 99 };

      expect((await POST(makeRequest(body1, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body2, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(5);
    });

    it("writes separate rows for different categories", async () => {
      const body1 = {
        ...validBody(),
        idempotencyKey: randomUUID(),
        category: "tweet.read",
        quantity: 3,
      };
      const body2 = {
        ...validBody(),
        idempotencyKey: randomUUID(),
        category: "users.read",
        quantity: 2,
      };

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

    it("rejects empty provider", async () => {
      const body = { ...validBody(), provider: "" };
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

    it("rejects non-UUID idempotencyKey", async () => {
      const body = { ...validBody(), idempotencyKey: "not-a-uuid" };
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });
  });
});
