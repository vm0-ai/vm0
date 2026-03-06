import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

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
  let testRunId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(`test-search-${Date.now()}`);

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
    context.mocks.axiom.queryAxiom.mockResolvedValue(null);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=test",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
  });

  it("should return matched events without context", async () => {
    // First call: search query returns matches
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
    expect(data.results[0].matchedEvent.sequenceNumber).toBe(3);
    expect(data.results[0].contextBefore).toEqual([]);
    expect(data.results[0].contextAfter).toEqual([]);
  });

  it("should return matched events with context", async () => {
    // First call: search query returns matches
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 5, "Error: OOM killed"),
    ]);

    // Second call: context query returns surrounding events
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      createAxiomAgentEvent(testRunId, 4, "Building..."),
      createAxiomAgentEvent(testRunId, 5, "Error: OOM killed"),
      createAxiomAgentEvent(testRunId, 6, "Retrying..."),
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=OOM&before=1&after=1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
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
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0][0] as string;
    expect(aplQuery).toContain(`runId == "${testRunId}"`);
  });

  it("should include keyword in Axiom search query", async () => {
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=deploy+failed",
    );

    await GET(request);

    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0][0] as string;
    expect(aplQuery).toContain("search");
    expect(aplQuery).toContain("deploy failed");
  });

  it("should filter by agent name via database lookup", async () => {
    // When agent filter is provided but no runs match, should return empty
    const request = createTestRequest(
      "http://localhost:3000/api/logs/search?keyword=test&agent=nonexistent-agent",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
    // Axiom should NOT have been called since no runs matched the agent filter
    expect(context.mocks.axiom.queryAxiom).not.toHaveBeenCalled();
  });

  it("should set hasMore when results exceed limit", async () => {
    // Return limit+1 events to trigger hasMore
    const events = Array.from({ length: 3 }, (_, i) =>
      createAxiomAgentEvent(testRunId, i, `Match ${i}`),
    );
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
});
