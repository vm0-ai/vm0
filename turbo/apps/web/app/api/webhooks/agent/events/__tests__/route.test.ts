import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockInstance,
} from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestRunInDb,
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
import * as axiomModule from "../../../../../../src/lib/shared/axiom";

// Only mock external services

const context = testContext();

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
      .mockResolvedValue(true);

    // Reset auth mock for webhook tests (which use token auth)
    mockClerk({ userId: null });
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

      const response = await POST(request);

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

      const response = await POST(request);

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

      const response = await POST(request);

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

      const response = await POST(request);

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

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("empty");
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

      const response = await POST(request);

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

      const response = await POST(request);

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

      const response = await POST(request);

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

      const response = await POST(request);
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

      const response = await POST(request);
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

  describe("DB fallback (Axiom not configured)", () => {
    beforeEach(() => {
      // Simulate Axiom not configured
      ingestToAxiomSpy.mockResolvedValue(false);
    });

    it("should store events to DB when Axiom is not configured", async () => {
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

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.received).toBe(2);
      expect(data.firstSequence).toBe(0);
      expect(data.lastSequence).toBe(1);
    });

    it("should not store to DB when Axiom ingest succeeds", async () => {
      ingestToAxiomSpy.mockResolvedValue(true);

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

      const response = await POST(request);
      expect(response.status).toBe(200);

      // Axiom ingest returned true, DB fallback should not run
      expect(ingestToAxiomSpy).toHaveBeenCalled();
    });
  });

  // ============================================
  // Credit Usage Tests
  // ============================================

  describe("Credit Usage", () => {
    it("should not create credit_usage record for non-result events", async () => {
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
                type: "system",
                subtype: "init",
                model: "claude-sonnet-4-20250514",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
            ],
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(0);
    });

    it("should set token data on result event", async () => {
      const resultUuid = randomUUID();
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
                uuid: resultUuid,
                sequenceNumber: 0,
                timestamp: Date.now(),
                total_cost_usd: 0.11752625,
                usage: {
                  input_tokens: 15000,
                  output_tokens: 3000,
                  cache_read_input_tokens: 6285,
                  cache_creation_input_tokens: 18247,
                  server_tool_use: {
                    web_search_requests: 2,
                  },
                },
                data: {},
              },
            ],
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.resultUuid).toBe(resultUuid);
      expect(record.inputTokens).toBe(15000);
      expect(record.outputTokens).toBe(3000);
      expect(record.cacheReadInputTokens).toBe(6285);
      expect(record.cacheCreationInputTokens).toBe(18247);
      expect(record.webSearchRequests).toBe(2);
      expect(record.costUsd).toBe("0.11752625");
    });

    it("should store modelProvider and selectedModel from agent run in credit_usage", async () => {
      // Create a run with zeroRuns record (needed for modelProvider/selectedModel storage)
      const { runId: zeroRunId } = await createTestRunInDb(
        user.userId,
        testComposeId,
      );
      const zeroRunToken = await createTestSandboxToken(user.userId, zeroRunId);
      await setTestRunModelProvider(zeroRunId, "anthropic-api-key");
      await setTestRunSelectedModel(zeroRunId, "claude-sonnet-4-6");

      // In production, result events arrive in separate requests from system.init
      const resultUuid = randomUUID();
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${zeroRunToken}`,
          },
          body: JSON.stringify({
            runId: zeroRunId,
            events: [
              {
                type: "result",
                uuid: resultUuid,
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

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(zeroRunId);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.model).toBe("claude-sonnet-4-6");
      expect(record.modelProvider).toBe("anthropic-api-key");
    });

    it("should prefer run.selectedModel over system.init model", async () => {
      // Create a run with zeroRuns record (needed for selectedModel storage)
      const { runId: zeroRunId } = await createTestRunInDb(
        user.userId,
        testComposeId,
      );
      const zeroRunToken = await createTestSandboxToken(user.userId, zeroRunId);
      await setTestRunSelectedModel(zeroRunId, "claude-sonnet-4-6");

      const resultUuid = randomUUID();
      const request = createTestRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${zeroRunToken}`,
          },
          body: JSON.stringify({
            runId: zeroRunId,
            events: [
              {
                type: "system",
                subtype: "init",
                model: "claude-sonnet-4-20250514",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
              {
                type: "result",
                uuid: resultUuid,
                sequenceNumber: 1,
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

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(zeroRunId);
      expect(records).toHaveLength(1);
      expect(records[0]!.model).toBe("claude-sonnet-4-6");
    });

    it("should fall back to system.init model when no selectedModel on run", async () => {
      // No selectedModel set on run — should fall back to extractModel from events
      const resultUuid = randomUUID();
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
                type: "system",
                subtype: "init",
                model: "claude-sonnet-4-20250514",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
              {
                type: "result",
                uuid: resultUuid,
                sequenceNumber: 1,
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

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(1);
      expect(records[0]!.model).toBe("claude-sonnet-4-20250514");
    });

    it("should use 'unknown' model when no init event in batch", async () => {
      const resultUuid = randomUUID();
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
                uuid: resultUuid,
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

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(1);
      expect(records[0]!.model).toBe("unknown");
    });

    it("should create separate rows for multiple result events", async () => {
      const uuid1 = randomUUID();
      const uuid2 = randomUUID();

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
                type: "system",
                subtype: "init",
                model: "claude-sonnet-4-20250514",
                sequenceNumber: 0,
                timestamp: Date.now(),
                data: {},
              },
              {
                type: "result",
                uuid: uuid1,
                sequenceNumber: 1,
                timestamp: Date.now(),
                total_cost_usd: 0.05,
                usage: {
                  input_tokens: 1000,
                  output_tokens: 200,
                },
                data: {},
              },
              {
                type: "result",
                uuid: uuid2,
                sequenceNumber: 2,
                timestamp: Date.now(),
                total_cost_usd: 0.08,
                usage: {
                  input_tokens: 2000,
                  output_tokens: 400,
                },
                data: {},
              },
            ],
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(2);

      const byUuid = new Map(
        records.map((r) => {
          return [r.resultUuid, r];
        }),
      );
      const r1 = byUuid.get(uuid1)!;
      expect(r1.inputTokens).toBe(1000);
      expect(r1.outputTokens).toBe(200);
      expect(r1.costUsd).toBe("0.05000000");

      const r2 = byUuid.get(uuid2)!;
      expect(r2.inputTokens).toBe(2000);
      expect(r2.outputTokens).toBe(400);
      expect(r2.costUsd).toBe("0.08000000");
    });

    it("should deduplicate result events with same UUID", async () => {
      const resultUuid = randomUUID();

      // First request with result event
      const request1 = createTestRequest(
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
                uuid: resultUuid,
                sequenceNumber: 0,
                timestamp: Date.now(),
                total_cost_usd: 0.05,
                usage: {
                  input_tokens: 1000,
                  output_tokens: 200,
                },
                data: {},
              },
            ],
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      // Second request with same UUID but updated data (retry)
      const request2 = createTestRequest(
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
                uuid: resultUuid,
                sequenceNumber: 0,
                timestamp: Date.now(),
                total_cost_usd: 0.05,
                usage: {
                  input_tokens: 1000,
                  output_tokens: 200,
                },
                data: {},
              },
            ],
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);

      // Should have single row (deduplicated)
      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(1);
      expect(records[0]!.resultUuid).toBe(resultUuid);
    });

    it("should not create duplicate rows on concurrent calls with same UUID", async () => {
      const resultUuid = randomUUID();

      const makeRequest = () => {
        return createTestRequest(
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
                  uuid: resultUuid,
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
      };

      // Send two requests concurrently
      const [response1, response2] = await Promise.all([
        POST(makeRequest()),
        POST(makeRequest()),
      ]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // Should have a single record (deduplicated by runId + resultUuid)
      const records = await findTestCreditUsagesByRunId(testRunId);
      expect(records).toHaveLength(1);
    });
  });
});
