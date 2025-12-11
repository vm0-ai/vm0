/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { POST } from "../route";
import { POST as createCompose } from "../../../../agent/composes/route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../../src/db/schema/agent-run-event";
import { cliTokens } from "../../../../../../src/db/schema/cli-tokens";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createDefaultComposeConfig,
} from "../../../../../../src/test/api-test-helpers";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("POST /api/webhooks/agent/events", () => {
  // Generate unique IDs for this test run to avoid conflicts
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testAgentName = `test-agent-events-${Date.now()}`;
  const testRunId = randomUUID(); // UUID for agent run
  let testVersionId: string;
  const testToken = `vm0_live_test_${Date.now()}_${process.pid}`;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Initialize services
    initServices();

    // Mock Clerk auth to return test user (needed for compose API)
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

    // Mock headers() to return a HeadersList-like object
    // By default, return no Authorization header (for auth failure tests)
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Clean up any existing test data
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));

    // Create test compose via API endpoint
    const config = createDefaultComposeConfig(testAgentName);
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await createCompose(request);
    const data = await response.json();
    testVersionId = data.versionId;

    // Reset auth mock for webhook tests (which use token auth)
    mockAuth.mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);
  });

  afterEach(async () => {
    // Clean up test data after each test
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, testUserId));

    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });

  afterAll(async () => {
    // Clean up database connections
  });

  // ============================================
  // P0 Tests: Authentication (3 tests)
  // ============================================

  describe("Authentication", () => {
    it("should reject webhook without authentication", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [{ type: "test", timestamp: Date.now(), data: {} }],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toBeDefined();
    });

    it("should reject webhook with expired token", async () => {
      // Create expired token
      const expiredToken = `vm0_live_expired_${Date.now()}_${process.pid}`;
      const now = new Date();
      const expiredAt = new Date(now.getTime() - 1000); // 1 second ago

      // Mock headers() to return the expired token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${expiredToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: expiredToken,
        userId: testUserId,
        name: "Expired Test Token",
        expiresAt: expiredAt,
        createdAt: now,
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${expiredToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [{ type: "test", timestamp: Date.now(), data: {} }],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);

      // Clean up expired token
      await globalThis.services.db
        .delete(cliTokens)
        .where(eq(cliTokens.token, expiredToken));
    });
  });

  // ============================================
  // P0 Tests: Validation (3 tests)
  // ============================================

  describe("Validation", () => {
    beforeEach(async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Create valid token for validation tests
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject webhook without runId", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            // runId: missing
            events: [{ type: "test", timestamp: Date.now(), data: {} }],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("runId");
    });

    it("should reject webhook without events array", async () => {
      const request = new NextRequest(
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
      const request = new NextRequest(
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
    beforeEach(async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Create valid token for authorization tests
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject webhook for non-existent run", async () => {
      const nonExistentRunId = randomUUID(); // Use a valid UUID that doesn't exist

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: nonExistentRunId,
            events: [{ type: "test", timestamp: Date.now(), data: {} }],
          }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject webhook for run owned by different user", async () => {
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;

      // Create run owned by different user
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: otherUserId, // different user
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testToken}`,
          },
          body: JSON.stringify({
            runId: testRunId,
            events: [{ type: "test", timestamp: Date.now(), data: {} }],
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
    it("should accept valid webhook with authentication", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Create valid token
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      // Create agent run owned by user
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = new NextRequest(
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
                timestamp: Date.now(),
                data: { tool: "bash", command: "ls" },
              },
              {
                type: "tool_result",
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
      expect(data.firstSequence).toBe(1);
      expect(data.lastSequence).toBe(2);

      // Verify database
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId))
        .orderBy(agentRunEvents.sequenceNumber);

      expect(events).toHaveLength(2);
      expect(events[0]?.sequenceNumber).toBe(1);
      expect(events[0]?.eventType).toBe("tool_use");
      expect(events[1]?.sequenceNumber).toBe(2);
      expect(events[1]?.eventType).toBe("tool_result");
    });
  });

  // ============================================
  // P1 Tests: Sequence Management (1 test)
  // ============================================

  describe("Sequence Management", () => {
    it("should increment sequence numbers across multiple calls", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      // First webhook - 2 events
      const request1 = new NextRequest(
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
              { type: "event1", timestamp: Date.now(), data: {} },
              { type: "event2", timestamp: Date.now(), data: {} },
            ],
          }),
        },
      );

      const response1 = await POST(request1);
      expect(response1.status).toBe(200);

      const data1 = await response1.json();
      expect(data1.firstSequence).toBe(1);
      expect(data1.lastSequence).toBe(2);

      // Second webhook - 3 events
      const request2 = new NextRequest(
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
              { type: "event3", timestamp: Date.now(), data: {} },
              { type: "event4", timestamp: Date.now(), data: {} },
              { type: "event5", timestamp: Date.now(), data: {} },
            ],
          }),
        },
      );

      const response2 = await POST(request2);
      expect(response2.status).toBe(200);

      const data2 = await response2.json();
      expect(data2.firstSequence).toBe(3); // continues from 3
      expect(data2.lastSequence).toBe(5);

      // Verify all events in database
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId))
        .orderBy(agentRunEvents.sequenceNumber);

      expect(events).toHaveLength(5);
      expect(events[0]?.sequenceNumber).toBe(1);
      expect(events[1]?.sequenceNumber).toBe(2);
      expect(events[2]?.sequenceNumber).toBe(3);
      expect(events[3]?.sequenceNumber).toBe(4);
      expect(events[4]?.sequenceNumber).toBe(5);
    });
  });

  // ============================================
  // P1 Tests: Data Integrity (1 test)
  // ============================================

  describe("Data Integrity", () => {
    it("should store event data correctly", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const testEvents = [
        {
          type: "thinking",
          timestamp: 1234567890,
          data: { text: "Analyzing the problem..." },
        },
        {
          type: "tool_use",
          timestamp: 1234567891,
          data: {
            tool: "bash",
            command: "npm test",
            args: ["--verbose"],
          },
        },
        {
          type: "tool_result",
          timestamp: 1234567892,
          data: {
            exitCode: 0,
            stdout: "All tests passed",
            stderr: "",
          },
        },
      ];

      const request = new NextRequest(
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

      // Verify database
      const events = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId))
        .orderBy(agentRunEvents.sequenceNumber);

      expect(events).toHaveLength(3);

      // Verify eventType matches event.type
      expect(events[0]?.eventType).toBe("thinking");
      expect(events[1]?.eventType).toBe("tool_use");
      expect(events[2]?.eventType).toBe("tool_result");

      // Verify eventData contains complete event object
      expect(events[0]?.eventData).toEqual(testEvents[0]);
      expect(events[1]?.eventData).toEqual(testEvents[1]);
      expect(events[2]?.eventData).toEqual(testEvents[2]);
    });
  });

  // ============================================
  // P1 Tests: Batch Processing (1 test)
  // ============================================

  describe("Batch Processing", () => {
    it("should handle multiple events in single request", async () => {
      // Mock headers() to return the test token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      // Setup
      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: testUserId,
        agentComposeVersionId: testVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      // Create 15 events
      const events = Array.from({ length: 15 }, (_, i) => ({
        type: `event_${i + 1}`,
        timestamp: Date.now() + i,
        data: { index: i + 1, message: `Event number ${i + 1}` },
      }));

      const request = new NextRequest(
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
      expect(data.firstSequence).toBe(1);
      expect(data.lastSequence).toBe(15);

      // Verify all events stored
      const storedEvents = await globalThis.services.db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, testRunId))
        .orderBy(agentRunEvents.sequenceNumber);

      expect(storedEvents).toHaveLength(15);

      // Verify sequence numbers are consecutive
      storedEvents.forEach((event, index) => {
        expect(event.sequenceNumber).toBe(index + 1);
        expect(event.eventType).toBe(`event_${index + 1}`);
      });
    });
  });
});
