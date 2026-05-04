import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestConnectorBillingByRunId,
  findTestUsageEventsByRunId,
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

  const validEvent = () => {
    return {
      idempotencyKey: randomUUID(),
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 5,
    };
  };

  const validBody = (event: Record<string, unknown> = validEvent()) => {
    return {
      runId: testRunId,
      events: [event],
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
        makeRequest({ runId: missingRunId, events: [validEvent()] }, token),
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
      const body1 = validBody({
        ...validEvent(),
        idempotencyKey: sharedKey,
        quantity: 5,
      });
      const body2 = validBody({
        ...validEvent(),
        idempotencyKey: sharedKey,
        quantity: 99,
      });

      expect((await POST(makeRequest(body1, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body2, testToken))).status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(5);
    });

    it("writes separate rows for different categories", async () => {
      const body1 = validBody({
        ...validEvent(),
        idempotencyKey: randomUUID(),
        category: "tweet.read",
        quantity: 3,
      });
      const body2 = validBody({
        ...validEvent(),
        idempotencyKey: randomUUID(),
        category: "users.read",
        quantity: 2,
      });

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
      const body = validBody({ ...validEvent(), quantity: 0 });
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(200);

      const rows = await findTestConnectorBillingByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe(0);
    });

    it("accepts a batch with model and image usage events", async () => {
      const modelEventId = randomUUID();
      const imageEventId = randomUUID();
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            events: [
              {
                idempotencyKey: modelEventId,
                kind: "model",
                provider: "claude-sonnet-4-6",
                category: "tokens.input",
                quantity: 123,
              },
              {
                idempotencyKey: imageEventId,
                kind: "image",
                provider: "gpt-image-1",
                category: "output_image",
                quantity: 1,
              },
            ],
          },
          testToken,
        ),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            idempotencyKey: modelEventId,
            kind: "model",
            provider: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 123,
            status: "pending",
          }),
          expect.objectContaining({
            idempotencyKey: imageEventId,
            kind: "image",
            provider: "gpt-image-1",
            category: "output_image",
            quantity: 1,
            status: "pending",
          }),
        ]),
      );
    });

    it("deduplicates duplicate idempotency keys inside a batch", async () => {
      const sharedKey = randomUUID();
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            events: [
              {
                idempotencyKey: sharedKey,
                kind: "connector",
                provider: "x",
                category: "tweet.read",
                quantity: 3,
              },
              {
                idempotencyKey: sharedKey,
                kind: "connector",
                provider: "x",
                category: "users.read",
                quantity: 7,
              },
            ],
          },
          testToken,
        ),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        idempotencyKey: sharedKey,
        provider: "x",
        category: "tweet.read",
        quantity: 3,
      });
    });

    it("deduplicates a retried batch by idempotencyKey", async () => {
      const firstEventId = randomUUID();
      const secondEventId = randomUUID();
      const body = {
        runId: testRunId,
        events: [
          {
            idempotencyKey: firstEventId,
            kind: "model",
            provider: "claude-sonnet-4-6",
            category: "tokens.input",
            quantity: 10,
          },
          {
            idempotencyKey: secondEventId,
            kind: "model",
            provider: "claude-sonnet-4-6",
            category: "tokens.output",
            quantity: 20,
          },
        ],
      };

      expect((await POST(makeRequest(body, testToken))).status).toBe(200);
      expect((await POST(makeRequest(body, testToken))).status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            idempotencyKey: firstEventId,
            category: "tokens.input",
            quantity: 10,
          }),
          expect.objectContaining({
            idempotencyKey: secondEventId,
            category: "tokens.output",
            quantity: 20,
          }),
        ]),
      );
    });

    it("accepts batches at the 100-event limit", async () => {
      const firstEventId = randomUUID();
      const lastEventId = randomUUID();
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            events: Array.from({ length: 100 }, (_, index) => {
              return {
                idempotencyKey:
                  index === 0
                    ? firstEventId
                    : index === 99
                      ? lastEventId
                      : randomUUID(),
                kind: "model",
                provider: "claude-sonnet-4-6",
                category: index % 2 === 0 ? "tokens.input" : "tokens.output",
                quantity: index + 1,
              };
            }),
          },
          testToken,
        ),
      );
      expect(response.status).toBe(200);

      const rows = await findTestUsageEventsByRunId(testRunId);
      expect(rows).toHaveLength(100);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            idempotencyKey: firstEventId,
            quantity: 1,
          }),
          expect.objectContaining({
            idempotencyKey: lastEventId,
            quantity: 100,
          }),
        ]),
      );
    });
  });

  // ── Validation ─────────────────────────────────────────────────────

  describe("Validation", () => {
    it("rejects negative quantity", async () => {
      const body = validBody({ ...validEvent(), quantity: -1 });
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it.each([
      {
        name: "non-integer quantity",
        body: () => {
          return validBody({ ...validEvent(), quantity: 1.5 });
        },
      },
      {
        name: "unknown kind",
        body: () => {
          return validBody({ ...validEvent(), kind: "external-api" });
        },
      },
      {
        name: "unexpected event field",
        body: () => {
          return validBody({ ...validEvent(), unexpected: true });
        },
      },
      {
        name: "unexpected top-level field",
        body: () => {
          return { ...validBody(), unexpected: true };
        },
      },
    ])("rejects $name", async ({ body }) => {
      const response = await POST(makeRequest(body(), testToken));
      expect(response.status).toBe(400);
    });

    it("rejects empty provider", async () => {
      const body = validBody({ ...validEvent(), provider: "" });
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it("rejects empty category", async () => {
      const body = validBody({ ...validEvent(), category: "" });
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it("rejects missing runId", async () => {
      const response = await POST(
        makeRequest({ events: [validEvent()] }, testToken),
      );
      expect(response.status).toBe(400);
    });

    it("rejects non-UUID idempotencyKey", async () => {
      const body = validBody({
        ...validEvent(),
        idempotencyKey: "not-a-uuid",
      });
      const response = await POST(makeRequest(body, testToken));
      expect(response.status).toBe(400);
    });

    it("rejects empty batches", async () => {
      const response = await POST(
        makeRequest({ runId: testRunId, events: [] }, testToken),
      );
      expect(response.status).toBe(400);
    });

    it("rejects the legacy single-event body", async () => {
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            ...validEvent(),
          },
          testToken,
        ),
      );
      expect(response.status).toBe(400);
    });

    it("rejects batches with more than 100 events", async () => {
      const response = await POST(
        makeRequest(
          {
            runId: testRunId,
            events: Array.from({ length: 101 }, (_, index) => {
              return {
                idempotencyKey: randomUUID(),
                kind: "model",
                provider: "claude-sonnet-4-6",
                category: index % 2 === 0 ? "tokens.input" : "tokens.output",
                quantity: index,
              };
            }),
          },
          testToken,
        ),
      );
      expect(response.status).toBe(400);
    });
  });
});
