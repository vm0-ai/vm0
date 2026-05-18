import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockInstance,
} from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestSandboxToken,
  findTestUsageEventsByRunId,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../../src/mocks/server";
import { randomUUID } from "crypto";
import * as axiomModule from "../../../../../../src/lib/shared/axiom";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";

async function handleAxiomApiConsumer(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    readonly runId: string;
    readonly events: readonly {
      readonly sequenceNumber: number;
      readonly type: string;
      readonly [key: string]: unknown;
    }[];
    readonly context: { readonly userId: string };
  };

  const axiomEvents = body.events.map((event) => {
    return {
      runId: body.runId,
      userId: body.context.userId,
      sequenceNumber: event.sequenceNumber,
      eventType: event.type,
      eventData: event,
    };
  });

  const ingested = axiomModule.ingestToAxiom(
    axiomModule.getDatasetName(axiomModule.DATASETS.AGENT_RUN_EVENTS),
    axiomEvents,
  );
  if (!ingested) {
    return HttpResponse.json(
      { error: "Axiom agent-run-events dataset is not configured" },
      { status: 503 },
    );
  }

  try {
    await axiomModule.flushAxiom({ throwOnError: true, client: "sessions" });
  } catch {
    return HttpResponse.json(
      { error: "Axiom agent-run-events flush failed" },
      { status: 503 },
    );
  }

  return HttpResponse.json({ received: body.events.length });
}

async function handleChatAssistantApiConsumer(
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as {
    readonly events?: readonly unknown[];
  };

  return HttpResponse.json({
    processed: Array.isArray(body.events) ? body.events.length : 0,
  });
}

function handleTelegramTypingApiConsumer(): Response {
  return HttpResponse.json({ scheduled: true });
}

const context = testContext();

/**
 * Send a request and drain `after()` so the mocked consumer dispatch has
 * completed before assertions.
 */
async function postAndFlush(request: Request): Promise<Response> {
  const response = await POST(request as never);
  await context.mocks.flushAfter();
  return response;
}

describe("POST /api/webhooks/agent/events", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;
  let ingestToAxiomSpy: MockInstance<typeof axiomModule.ingestToAxiom>;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose via API
    const { composeId } = await createTestCompose(uniqueId("agent-events"));
    testComposeId = composeId;

    // Create test run via API (status automatically set to running)
    const { runId } = await createTestRun(testComposeId, "Test prompt");
    testRunId = runId;

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(user.userId, testRunId);

    // Setup spy on ingestToAxiom - returns true by default
    ingestToAxiomSpy = vi
      .spyOn(axiomModule, "ingestToAxiom")
      .mockReturnValue(true);
    mockAblyPublish.mockClear();

    // Reset auth mock for webhook tests (which use token auth)
    mockClerk({ userId: null });

    // Route the webhook's internal fetches through MSW to the real consumer
    // route handlers so HMAC verification + business logic run end-to-end.
    server.use(
      http.post(
        "http://localhost:3000/api/internal/event-consumers/axiom",
        ({ request }) => {
          return handleAxiomApiConsumer(request);
        },
      ),
      http.post(
        "http://localhost:3000/api/internal/event-consumers/chat-assistant",
        ({ request }) => {
          return handleChatAssistantApiConsumer(request);
        },
      ),
      http.post(
        "http://localhost:3000/api/internal/event-consumers/telegram-typing",
        () => {
          return handleTelegramTypingApiConsumer();
        },
      ),
      http.post(
        "http://localhost:3000/api/internal/event-consumers/agentphone-typing",
        () => {
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
  });

  // ============================================
  // P0 Tests: Authentication (3 tests)
  // ============================================

  describe("Authentication", () => {
    it("should reject webhook without authentication", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toBeDefined();
    });

    it("should reject webhook with invalid token", async () => {
      const invalidToken = "invalid-token-not-jwt";

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${invalidToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(401);
    });
  });

  // ============================================
  // P0 Tests: Validation (3 tests)
  // ============================================

  describe("Validation", () => {
    it("should reject webhook without runId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject webhook without events array", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            // events: missing
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("events");
    });

    it("should reject webhook with empty events array", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [], // empty array
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("empty");
    });

    it("should reject event with negative sequenceNumber", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "test",
                sequenceNumber: -1,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("sequenceNumber");
    });

    it("should reject event sequenceNumber outside the database integer range", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 2_147_483_648,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("sequenceNumber");
    });
  });

  // ============================================
  // P0 Tests: Authorization (2 tests)
  // ============================================

  describe("Authorization", () => {
    it("should reject webhook for non-existent run", async () => {
      const nonExistentRunId = randomUUID();
      // Generate JWT with the non-existent runId
      const tokenForNonExistentRun = await createTestSandboxToken(
        user.userId,
        nonExistentRunId,
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForNonExistentRun}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject webhook for run owned by different user", async () => {
      // Create another user and their compose/run
      await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-agent-events-${Date.now()}`,
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
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenForOtherRun}`,
          },
          body: JSON.stringify({
            runId: otherRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(404); // 404 for security (not 403)
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });
  });

  // ============================================
  // P0 Tests: Success (1 test)
  // ============================================

  describe("Success", () => {
    it("should accept valid webhook and ingest to Axiom", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "tool_use",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: { tool: "bash", command: "ls" },
              },
              {
                type: "tool_result",
                sequenceNumber: 1,
                timestamp: Date.now(),
                data: { exitCode: 0, stdout: "file1.txt\nfile2.txt" },
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      // Verify response
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.received).toBe(2);
      expect(data.firstSequence).toBe(0);
      expect(data.lastSequence).toBe(1);

      // Verify Axiom was called with client-provided sequence numbers
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
        "vm0-agent-run-events-dev",
        expect.arrayContaining([
          expect.objectContaining({
            runId: testRunId,
            userId: user.userId,
            sequenceNumber: 0,
            eventType: "tool_use",
          }),
          expect.objectContaining({
            runId: testRunId,
            userId: user.userId,
            sequenceNumber: 1,
            eventType: "tool_result",
          }),
        ]),
      );
      expect(mockAblyPublish).toHaveBeenCalledWith(`run:changed:${testRunId}`, {
        firstSequence: 0,
        lastSequence: 1,
      });
    });
  });

  // ============================================
  // P1 Tests: Data Integrity (1 test)
  // ============================================

  describe("Data Integrity", () => {
    it("should store event data correctly in Axiom", async () => {
      const testEvents = [
        {
          type: "thinking",
          sequenceNumber: 0,
          timestamp: 1234567890,
          data: { text: "Analyzing the problem..." },
        },
        {
          type: "tool_use",
          sequenceNumber: 1,
          timestamp: 1234567891,
          data: {
            tool: "bash",
            command: "npm test",
            args: ["--verbose"],
          },
        },
        {
          type: "tool_result",
          sequenceNumber: 2,
          timestamp: 1234567892,
          data: {
            exitCode: 0,
            stdout: "All tests passed",
            stderr: "",
          },
        },
      ];

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: testEvents,
          }),
        },
      );

      const response = await postAndFlush(request);
      expect(response.status).toBe(200);

      // Verify Axiom was called with correct event types
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
        "vm0-agent-run-events-dev",
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "thinking",
            eventData: testEvents[0],
          }),
          expect.objectContaining({
            eventType: "tool_use",
            eventData: testEvents[1],
          }),
          expect.objectContaining({
            eventType: "tool_result",
            eventData: testEvents[2],
          }),
        ]),
      );
    });
  });

  // ============================================
  // P1 Tests: Batch Processing (1 test)
  // ============================================

  describe("Batch Processing", () => {
    it("should handle multiple events in single request", async () => {
      // Create 15 events with client-provided sequence numbers (0-based)
      const events = Array.from({ length: 15 }, (_, i) => {
        return {
          type: `event_${i}`,
          sequenceNumber: i,
          timestamp: Date.now() + i,
          data: { index: i, message: `Event number ${i}` },
        };
      });

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events,
          }),
        },
      );

      const response = await postAndFlush(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.received).toBe(15);
      expect(data.firstSequence).toBe(0);
      expect(data.lastSequence).toBe(14);

      // Verify Axiom was called with all 15 events
      expect(ingestToAxiomSpy).toHaveBeenCalledWith(
        "vm0-agent-run-events-dev",
        expect.arrayContaining(
          events.map((_, i) => {
            return expect.objectContaining({
              sequenceNumber: i,
              eventType: `event_${i}`,
            });
          }),
        ),
      );
    });
  });

  describe("Required Axiom dispatch", () => {
    beforeEach(() => {
      // Simulate Axiom not configured
      ingestToAxiomSpy.mockReturnValue(false);
    });

    it("should reject events when Axiom is not configured", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "tool_use",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: { tool: "bash", command: "ls" },
              },
              {
                type: "tool_result",
                sequenceNumber: 1,
                timestamp: Date.now(),
                data: { exitCode: 0, stdout: "file1.txt" },
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(500);
      expect(ingestToAxiomSpy).toHaveBeenCalled();
    });

    it("should not dispatch optional consumers when required Axiom fails", async () => {
      let chatAssistantCalls = 0;
      server.use(
        http.post(
          "http://localhost:3000/api/internal/event-consumers/chat-assistant",
          () => {
            chatAssistantCalls++;
            return HttpResponse.json({ processed: 1 });
          },
        ),
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: { content: "hello" },
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(500);
      expect(chatAssistantCalls).toBe(0);
    });

    it("should reject events when Axiom flush fails", async () => {
      ingestToAxiomSpy.mockReturnValue(true);
      context.mocks.axiom.flushAxiom.mockRejectedValueOnce(
        new Error("flush failed"),
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(500);
    });

    it("should accept events when an optional consumer fails", async () => {
      ingestToAxiomSpy.mockReturnValue(true);
      server.use(
        http.post(
          "http://localhost:3000/api/internal/event-consumers/chat-assistant",
          () => {
            return HttpResponse.json(
              { error: "chat assistant down" },
              { status: 503 },
            );
          },
        ),
      );

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: { content: "hello" },
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);

      expect(response.status).toBe(200);
    });

    it("should accept events when Axiom ingest and flush succeeds", async () => {
      ingestToAxiomSpy.mockReturnValue(true);

      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "test",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);
      expect(response.status).toBe(200);

      expect(ingestToAxiomSpy).toHaveBeenCalled();
      expect(context.mocks.axiom.flushAxiom).toHaveBeenCalledWith({
        throwOnError: true,
        client: "sessions",
      });
    });
  });

  // ============================================
  // Billing Isolation Tests
  // ============================================

  describe("Billing Isolation", () => {
    it("does not write usage_event rows for result events", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [
              {
                type: "result",
                uuid: randomUUID(),
                sequenceNumber: 0,
                timestamp: Date.now(),
                usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                },
                data: {},
              },
            ],
          }),
        },
      );

      const response = await postAndFlush(request);
      expect(response.status).toBe(200);

      const usageRows = await findTestUsageEventsByRunId(testRunId);
      expect(usageRows).toHaveLength(0);
    });
  });
});
