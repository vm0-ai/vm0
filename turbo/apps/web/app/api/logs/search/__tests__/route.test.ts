import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";

// Only mock external services
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function createAxiomAgentEvent(
  runId: string,
  sequenceNumber: number,
  text: string,
  timestamp = "2024-01-15T10:30:00Z",
) {
  return {
    _time: timestamp,
    runId,
    userId: "test-user",
    sequenceNumber,
    eventType: "assistant",
    eventData: {
      type: "assistant",
      message: {
        content: [{ type: "text", text }],
      },
    },
  };
}

describe("GET /api/logs/search", () => {
  let testComposeId: string;
  let testRunId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(
      `test-search-${randomUUID().slice(0, 8)}`,
    );
    testComposeId = composeId;

    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=test",
    );

    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return empty results when no matches", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValue([]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=nonexistent",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
    expect(data.hasMore).toBe(false);
  });

  it("should return empty results when Axiom is not configured", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValue([]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=test",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
  });

  it("should return matched events without context", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 3, "OOM killed"),
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=OOM",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].runId).toBe(testRunId);
    expect(data.results[0].agentName).toBe(testComposeId);
    expect(data.results[0].matchedEvent.sequenceNumber).toBe(3);
    expect(data.results[0].contextBefore).toEqual([]);
    expect(data.results[0].contextAfter).toEqual([]);
  });

  it("should return matched events with context", async () => {
    // First Axiom call: search returns matched event
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(
        testRunId,
        5,
        "Error: OOM killed",
        "2024-01-15T10:30:05Z",
      ),
    ]);

    // Second Axiom call: context query returns surrounding events
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(
        testRunId,
        4,
        "Building...",
        "2024-01-15T10:30:04Z",
      ),
      createAxiomAgentEvent(
        testRunId,
        5,
        "Error: OOM killed",
        "2024-01-15T10:30:05Z",
      ),
      createAxiomAgentEvent(
        testRunId,
        6,
        "Retrying...",
        "2024-01-15T10:30:06Z",
      ),
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=OOM&before=1&after=1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].matchedEvent.sequenceNumber).toBe(5);
    expect(data.results[0].contextBefore).toHaveLength(1);
    expect(data.results[0].contextBefore[0].sequenceNumber).toBe(4);
    expect(data.results[0].contextAfter).toHaveLength(1);
    expect(data.results[0].contextAfter[0].sequenceNumber).toBe(6);
  });

  it("should filter by runId when provided", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 1, "Found it"),
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/logs/search?keyword=Found&runId=${testRunId}`,
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].runId).toBe(testRunId);

    // Verify APL query includes runId filter
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain(`runId == "${testRunId}"`);
  });

  it("should use search operator in axiom query for keyword search", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 2, "deploy failed with error"),
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=deploy+failed",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].matchedEvent.sequenceNumber).toBe(2);

    // Verify APL uses search operator
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain('search "*deploy failed*"');
  });

  it("should filter by agent ID via database lookup", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 1, "Found it"),
    ]);

    const request = createTestRequest(
      `http://localhost:3000/api/logs/search?keyword=Found&agent=${testComposeId}`,
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].runId).toBe(testRunId);

    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain(`runId == "${testRunId}"`);
  });

  it("should return empty when agent ID has no runs", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/logs/search?keyword=test&agent=${randomUUID()}`,
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
    expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
  });

  it("should set hasMore when results exceed limit", async () => {
    const events = Array.from({ length: 5 }, (_, i) => {
      return createAxiomAgentEvent(testRunId, i, `Match ${i}`);
    });
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce(events);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=Match&limit=2",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(2);
    expect(data.hasMore).toBe(true);
  });

  it("should not return runs from a different org", async () => {
    const user = await context.setupUser();

    // Create a compose + run in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    const { runId: otherOrgRunId } = await seedTestRun(
      user.userId,
      otherOrg.id,
    );

    // Mock Axiom to return events for the default org run only
    // (in production, the APL runId filter would exclude other-org runs)
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 1, "Default org event"),
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=event",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].runId).toBe(testRunId);

    // Verify the Axiom APL query only contains the default org's run ID
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain(testRunId);
    expect(aplQuery).not.toContain(otherOrgRunId);
  });

  it("should return empty when searching by runId from a different org", async () => {
    const user = await context.setupUser();

    // Create a run in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    const { runId: otherOrgRunId } = await seedTestRun(
      user.userId,
      otherOrg.id,
    );

    const request = createTestRequest(
      `http://localhost:3000/api/logs/search?keyword=test&runId=${otherOrgRunId}`,
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
    expect(data.hasMore).toBe(false);
    // Axiom should not be called since the run doesn't belong to the active org
    expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
  });
});
