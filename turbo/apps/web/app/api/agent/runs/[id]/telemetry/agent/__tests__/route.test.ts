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
import { GET } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../../../../src/db/schema/agent-run-event";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

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

/**
 * Helper to create a NextRequest for testing.
 */
function createTestRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/agent/runs/:id/telemetry/agent", () => {
  const testUserId = `test-user-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  const testComposeId = randomUUID();
  const testVersionId =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as unknown as Awaited<ReturnType<typeof auth>>);

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
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));

    // Create test agent compose
    await globalThis.services.db.insert(agentComposes).values({
      id: testComposeId,
      userId: testUserId,
      name: "test-agent",
      headVersionId: testVersionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create test agent version
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: testVersionId,
      composeId: testComposeId,
      content: {
        agents: {
          "test-agent": {
            name: "test-agent",
            model: "claude-3-5-sonnet-20241022",
            working_dir: "/workspace",
          },
        },
      },
      createdBy: testUserId,
      createdAt: new Date(),
    });

    // Create test agent run
    await globalThis.services.db.insert(agentRuns).values({
      id: testRunId,
      userId: testUserId,
      agentComposeVersionId: testVersionId,
      status: "running",
      prompt: "Test prompt",
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    await globalThis.services.db
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.runId, testRunId));

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, testRunId));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, testVersionId));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, testComposeId));
  });

  afterAll(async () => {
    // Clean up database connections
  });

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      mockAuth.mockResolvedValue({
        userId: null,
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(data.error.message).toContain("authenticated");
    });
  });

  describe("Authorization", () => {
    it("should reject request for non-existent run", async () => {
      const nonExistentRunId = randomUUID();

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${nonExistentRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");
    });

    it("should reject request for run owned by different user", async () => {
      const otherUserId = `other-user-${Date.now()}-${process.pid}`;
      const otherRunId = randomUUID();
      const otherComposeId = randomUUID();
      const otherVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

      await globalThis.services.db.insert(agentComposes).values({
        id: otherComposeId,
        userId: otherUserId,
        name: "other-agent",
        headVersionId: otherVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await globalThis.services.db.insert(agentComposeVersions).values({
        id: otherVersionId,
        composeId: otherComposeId,
        content: {
          agents: {
            "other-agent": {
              name: "other-agent",
              model: "claude-3-5-sonnet-20241022",
              working_dir: "/workspace",
            },
          },
        },
        createdBy: otherUserId,
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: otherRunId,
        userId: otherUserId,
        agentComposeVersionId: otherVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error.message).toContain("Agent run");

      // Clean up
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, otherRunId));
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, otherVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, otherComposeId));
    });
  });

  describe("Success - Basic Retrieval", () => {
    it("should return empty events when no events exist", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
    });

    it("should return agent events", async () => {
      await globalThis.services.db.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: 1,
        eventType: "init",
        eventData: { type: "init", model: "claude-3" },
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[0].eventType).toBe("init");
      expect(data.events[0].eventData).toEqual({
        type: "init",
        model: "claude-3",
      });
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Multiple Events", () => {
    it("should return events in chronological order", async () => {
      const now = Date.now();

      await globalThis.services.db.insert(agentRunEvents).values([
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "init",
          eventData: { type: "init" },
          createdAt: new Date(now - 3000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "text",
          eventData: { type: "text", content: "Hello" },
          createdAt: new Date(now - 2000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 3,
          eventType: "tool_use",
          eventData: { type: "tool_use", name: "bash" },
          createdAt: new Date(now - 1000),
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 4,
          eventType: "result",
          eventData: { type: "result", success: true },
          createdAt: new Date(now),
        },
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(4);
      expect(data.events[0].eventType).toBe("init");
      expect(data.events[1].eventType).toBe("text");
      expect(data.events[2].eventType).toBe("tool_use");
      expect(data.events[3].eventType).toBe("result");
      expect(data.hasMore).toBe(false);
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter", async () => {
      const now = Date.now();

      // Insert 5 events
      await globalThis.services.db.insert(agentRunEvents).values(
        [1, 2, 3, 4, 5].map((seq) => ({
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: seq,
          eventType: `event${seq}`,
          eventData: { type: `event${seq}` },
          createdAt: new Date(now - (6 - seq) * 1000),
        })),
      );

      // Request with limit=3
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?limit=3`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(3);
      expect(data.events[0].sequenceNumber).toBe(1);
      expect(data.events[1].sequenceNumber).toBe(2);
      expect(data.events[2].sequenceNumber).toBe(3);
      expect(data.hasMore).toBe(true);
    });

    it("should filter by since parameter", async () => {
      const now = Date.now();
      const oldTime = new Date(now - 10000);
      const recentTime = new Date(now - 1000);

      await globalThis.services.db.insert(agentRunEvents).values([
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 1,
          eventType: "old_event",
          eventData: { type: "old" },
          createdAt: oldTime,
        },
        {
          id: randomUUID(),
          runId: testRunId,
          sequenceNumber: 2,
          eventType: "recent_event",
          eventData: { type: "recent" },
          createdAt: recentTime,
        },
      ]);

      // Request with since parameter that excludes the old event
      const sinceTimestamp = now - 5000;
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent?since=${sinceTimestamp}&limit=10`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events).toHaveLength(1);
      expect(data.events[0].eventType).toBe("recent_event");
    });
  });

  describe("Event Data", () => {
    it("should include createdAt as ISO string", async () => {
      const testTime = new Date("2024-01-15T10:30:00.000Z");

      await globalThis.services.db.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: 1,
        eventType: "test",
        eventData: { type: "test" },
        createdAt: testTime,
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events[0].createdAt).toBe("2024-01-15T10:30:00.000Z");
    });

    it("should preserve complex event data structures", async () => {
      const complexEventData = {
        type: "tool_result",
        tool: "bash",
        result: {
          stdout: "hello world",
          stderr: "",
          exitCode: 0,
        },
        metadata: {
          duration_ms: 150,
          retries: 0,
        },
      };

      await globalThis.services.db.insert(agentRunEvents).values({
        id: randomUUID(),
        runId: testRunId,
        sequenceNumber: 1,
        eventType: "tool_result",
        eventData: complexEventData,
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.events[0].eventData).toEqual(complexEventData);
    });
  });

  describe("Provider Field", () => {
    it("should return default provider 'claude-code' for compose without provider", async () => {
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${testRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.provider).toBe("claude-code");
    });

    it("should return 'codex' provider when compose has codex provider", async () => {
      // Create a compose with codex provider
      const codexComposeId = randomUUID();
      const codexVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const codexRunId = randomUUID();

      await globalThis.services.db.insert(agentComposes).values({
        id: codexComposeId,
        userId: testUserId,
        name: "codex-agent",
        headVersionId: codexVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await globalThis.services.db.insert(agentComposeVersions).values({
        id: codexVersionId,
        composeId: codexComposeId,
        content: {
          agent: {
            provider: "codex",
            model: "codex",
          },
        },
        createdBy: testUserId,
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: codexRunId,
        userId: testUserId,
        agentComposeVersionId: codexVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${codexRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.provider).toBe("codex");

      // Clean up
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, codexRunId));
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, codexVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, codexComposeId));
    });

    it("should return explicit provider from compose configuration", async () => {
      // Create a compose with explicit claude-code provider
      const explicitComposeId = randomUUID();
      const explicitVersionId =
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const explicitRunId = randomUUID();

      await globalThis.services.db.insert(agentComposes).values({
        id: explicitComposeId,
        userId: testUserId,
        name: "explicit-agent",
        headVersionId: explicitVersionId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await globalThis.services.db.insert(agentComposeVersions).values({
        id: explicitVersionId,
        composeId: explicitComposeId,
        content: {
          agent: {
            provider: "claude-code",
            model: "claude-3-5-sonnet-20241022",
          },
        },
        createdBy: testUserId,
        createdAt: new Date(),
      });

      await globalThis.services.db.insert(agentRuns).values({
        id: explicitRunId,
        userId: testUserId,
        agentComposeVersionId: explicitVersionId,
        status: "running",
        prompt: "Test prompt",
        createdAt: new Date(),
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${explicitRunId}/telemetry/agent`,
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.provider).toBe("claude-code");

      // Clean up
      await globalThis.services.db
        .delete(agentRuns)
        .where(eq(agentRuns.id, explicitRunId));
      await globalThis.services.db
        .delete(agentComposeVersions)
        .where(eq(agentComposeVersions.id, explicitVersionId));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, explicitComposeId));
    });
  });
});
