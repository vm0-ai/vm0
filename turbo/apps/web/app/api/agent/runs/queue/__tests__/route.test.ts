import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  insertUserCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/agent/runs/queue", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns concurrency context with empty queue", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.concurrency).toEqual(
      expect.objectContaining({
        limit: expect.any(Number),
        active: 0,
        available: expect.any(Number),
      }),
    );
    expect(data.queue).toEqual([]);
  });

  it("counts active runs (running + fresh pending)", async () => {
    // Create running and pending runs
    await createTestRunInDb(user.userId, testComposeId, {
      status: "running",
    });
    await createTestRunInDb(user.userId, testComposeId, {
      status: "pending",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.concurrency.active).toBe(2);
  });

  it("returns queued runs in FIFO order with correct positions", async () => {
    // Create queued runs with explicit timestamps to ensure deterministic ordering
    const now = Date.now();
    await createTestRunInDb(user.userId, testComposeId, {
      status: "queued",
      prompt: "first queued",
      createdAt: new Date(now - 1000),
    });
    await createTestRunInDb(user.userId, testComposeId, {
      status: "queued",
      prompt: "second queued",
      createdAt: new Date(now),
    });

    // Insert user cache so email resolution works without Clerk API
    await insertUserCacheEntry({
      userId: user.userId,
      email: "test@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.queue).toHaveLength(2);
    expect(data.queue[0].position).toBe(1);
    expect(data.queue[1].position).toBe(2);
    // FIFO: first created should be position 1
    expect(new Date(data.queue[0].createdAt).getTime()).toBeLessThanOrEqual(
      new Date(data.queue[1].createdAt).getTime(),
    );
  });

  it("masks agentName and userEmail for other users' runs", async () => {
    const otherUserId = uniqueId("other-user");

    // Both users' runs use the same compose (same org)
    await createTestRunInDb(user.userId, testComposeId, {
      status: "queued",
    });
    // Insert run for other user using same compose (orgId comes from compose)
    await createTestRunInDb(otherUserId, testComposeId, {
      status: "queued",
    });

    // Insert user cache entry only for requesting user
    await insertUserCacheEntry({
      userId: user.userId,
      email: "alice@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.queue).toHaveLength(2);

    const ownEntry = data.queue.find(
      (e: { runId: string | null }) => e.runId !== null,
    );
    const otherEntry = data.queue.find(
      (e: { runId: string | null }) => e.runId === null,
    );

    // Own run should include real data and runId
    expect(ownEntry).toBeDefined();
    expect(ownEntry.runId).toBeTruthy();
    expect(ownEntry.userEmail).toBe("alice@example.com");
    expect(ownEntry.agentName).toBeTruthy();

    // Other user's run should have null for private fields
    expect(otherEntry).toBeDefined();
    expect(otherEntry.runId).toBeNull();
    expect(otherEntry.agentName).toBeNull();
    expect(otherEntry.userEmail).toBeNull();
  });

  it("never exposes prompt in response", async () => {
    await createTestRunInDb(user.userId, testComposeId, {
      status: "queued",
      prompt: "secret-prompt-content",
    });

    await insertUserCacheEntry({
      userId: user.userId,
      email: "test@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const responseStr = JSON.stringify(data);
    expect(responseStr).not.toContain("secret-prompt-content");
    // Verify no prompt field exists on queue entries
    for (const entry of data.queue) {
      expect(entry).not.toHaveProperty("prompt");
    }
  });

  it("only shows runs from the requested org", async () => {
    // Create runs in the default org
    await createTestRunInDb(user.userId, testComposeId, {
      status: "queued",
    });

    await insertUserCacheEntry({
      userId: user.userId,
      email: "test@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Should only see runs from user's org (all own entries have runId)
    expect(data.queue.length).toBeGreaterThanOrEqual(1);
    for (const entry of data.queue) {
      expect(entry.runId).toBeTruthy();
    }
  });

  it("resolves user emails correctly", async () => {
    await createTestRunInDb(user.userId, testComposeId, {
      status: "queued",
    });

    await insertUserCacheEntry({
      userId: user.userId,
      email: "resolved@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.queue[0].userEmail).toBe("resolved@example.com");
  });

  it("does not count completed or failed runs as active", async () => {
    await createTestRunInDb(user.userId, testComposeId, {
      status: "completed",
    });
    await createTestRunInDb(user.userId, testComposeId, {
      status: "failed",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.concurrency.active).toBe(0);
  });
});
