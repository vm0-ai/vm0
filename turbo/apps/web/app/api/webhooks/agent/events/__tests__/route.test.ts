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
  createTestSandboxToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { randomUUID } from "crypto";
import * as axiomModule from "../../../../../../src/lib/axiom";

// Only mock external services
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/webhooks/agent/events", () => {
  let user: UserContext;
  let testComposeId: string;
  let testRunId: string;
  let testToken: string;
  let ingestToAxiomSpy: MockInstance<typeof axiomModule.ingestToAxiom>;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose via API
    const { composeId } = await createTestCompose(
      `agent-events-${randomUUID().slice(0, 8)}`,
    );
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
      const events = Array.from({ length: 15 }, (_, i) => ({
        type: `event_${i}`,
        sequenceNumber: i,
        timestamp: Date.now() + i,
        data: { index: i, message: `Event number ${i}` },
      }));

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
          events.map((_, i) =>
            expect.objectContaining({
              sequenceNumber: i,
              eventType: `event_${i}`,
            }),
          ),
        ),
      );
    });
  });
});
