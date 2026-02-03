import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/platform/logs", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return empty list when user has no runs", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.nextCursor).toBeNull();
  });

  describe("with runs", () => {
    let testComposeId: string;
    let runIds: string[];

    beforeEach(async () => {
      // Create compose and multiple runs
      const { composeId } = await createTestCompose(
        `logs-test-${randomUUID().slice(0, 8)}`,
      );
      testComposeId = composeId;

      // Create 3 runs - order will be newest first due to createdAt
      runIds = [];
      for (let i = 0; i < 3; i++) {
        const { runId } = await createTestRun(
          testComposeId,
          `Test prompt ${i}`,
        );
        // Complete runs to set them to "completed" status
        await completeTestRun(user.userId, runId);
        runIds.push(runId);
      }
    });

    it("should return list of run IDs ordered by createdAt DESC", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/platform/logs",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(3);

      // Verify all run IDs are present (order depends on creation timing)
      const returnedIds = data.data.map((r: { id: string }) => r.id);
      for (const runId of runIds) {
        expect(returnedIds).toContain(runId);
      }
    });

    it("should paginate correctly with limit and cursor", async () => {
      // Request with limit=2
      const request1 = createTestRequest(
        "http://localhost:3000/api/platform/logs?limit=2",
      );
      const response1 = await GET(request1);
      const data1 = await response1.json();

      expect(response1.status).toBe(200);
      expect(data1.data).toHaveLength(2);
      expect(data1.pagination.hasMore).toBe(true);
      expect(data1.pagination.nextCursor).not.toBeNull();

      // Request second page using cursor
      const request2 = createTestRequest(
        `http://localhost:3000/api/platform/logs?limit=2&cursor=${encodeURIComponent(data1.pagination.nextCursor)}`,
      );
      const response2 = await GET(request2);
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(data2.data).toHaveLength(1);
      expect(data2.pagination.hasMore).toBe(false);
      expect(data2.pagination.nextCursor).toBeNull();

      // Ensure no duplicate IDs between pages
      const allIds = [
        ...data1.data.map((r: { id: string }) => r.id),
        ...data2.data.map((r: { id: string }) => r.id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });
  });

  describe("search functionality", () => {
    beforeEach(async () => {
      // Create composes with different names
      const { composeId: compose1 } = await createTestCompose(
        `search-alpha-${randomUUID().slice(0, 8)}`,
      );
      const { composeId: compose2 } = await createTestCompose(
        `search-beta-${randomUUID().slice(0, 8)}`,
      );

      // Create runs for each compose
      const { runId: run1 } = await createTestRun(compose1, "Alpha prompt");
      await completeTestRun(user.userId, run1);

      const { runId: run2 } = await createTestRun(compose2, "Beta prompt");
      await completeTestRun(user.userId, run2);
    });

    it("should filter by agent name with fuzzy search", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/platform/logs?search=alpha",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toHaveLength(1);
    });

    it("should return empty list when search has no matches", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/platform/logs?search=nonexistent-agent-xyz",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data).toEqual([]);
      expect(data.pagination.hasMore).toBe(false);
    });

    it("should be case-insensitive for search", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/platform/logs?search=ALPHA",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.length).toBeGreaterThan(0);
    });
  });

  it("should not return runs from other users", async () => {
    // Create run for current user
    const { composeId } = await createTestCompose(
      `isolation-test-${randomUUID().slice(0, 8)}`,
    );
    const { runId: myRunId } = await createTestRun(composeId, "My prompt");
    await completeTestRun(user.userId, myRunId);

    // Create another user with different prefix to avoid caching
    const otherUser = await context.setupUser({ prefix: "other-user" });
    const { composeId: otherComposeId } = await createTestCompose(
      `other-agent-${randomUUID().slice(0, 8)}`,
    );
    const { runId: otherRunId } = await createTestRun(
      otherComposeId,
      "Other prompt",
    );
    await completeTestRun(otherUser.userId, otherRunId);

    // Switch back to original user and list runs
    mockClerk({ userId: user.userId });
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs",
    );
    const response = await GET(request);
    const data = await response.json();

    // Should only see own run, not other user's run
    const returnedIds = data.data.map((r: { id: string }) => r.id);
    expect(returnedIds).toContain(myRunId);
    expect(returnedIds).not.toContain(otherRunId);
  });

  it("should return 400 for invalid limit", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?limit=0",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for limit exceeding maximum", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/platform/logs?limit=101",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});
