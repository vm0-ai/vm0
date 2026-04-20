import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertUserCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

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
    await seedTestRun(user.userId, testComposeId, {
      status: "running",
    });
    await seedTestRun(user.userId, testComposeId, {
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
    await seedTestRun(user.userId, testComposeId, {
      status: "queued",
      prompt: "first queued",
      createdAt: new Date(now - 1000),
    });
    await seedTestRun(user.userId, testComposeId, {
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
    await seedTestRun(user.userId, testComposeId, {
      status: "queued",
    });
    // Insert run for other user using same compose (orgId comes from compose)
    await seedTestRun(otherUserId, testComposeId, {
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

    const ownEntry = data.queue.find((e: { runId: string | null }) => {
      return e.runId !== null;
    });
    const otherEntry = data.queue.find((e: { runId: string | null }) => {
      return e.runId === null;
    });

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

  it("exposes prompt only for own runs, hides for others", async () => {
    const otherUserId = uniqueId("other-user");

    await seedTestRun(user.userId, testComposeId, {
      status: "queued",
      prompt: "my-prompt-content",
    });
    await seedTestRun(otherUserId, testComposeId, {
      status: "queued",
      prompt: "secret-prompt-content",
    });

    await insertUserCacheEntry({
      userId: user.userId,
      email: "alice@example.com",
    });
    await insertUserCacheEntry({
      userId: otherUserId,
      email: "bob@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);

    const ownEntry = data.queue.find((e: { isOwner: boolean }) => {
      return e.isOwner === true;
    });
    const otherEntry = data.queue.find((e: { isOwner: boolean }) => {
      return e.isOwner === false;
    });

    // Own run should include prompt
    expect(ownEntry.prompt).toBe("my-prompt-content");
    expect(ownEntry.triggerSource).toBe("cli");

    // Other user's run should NOT include prompt
    expect(otherEntry.prompt).toBeNull();
    expect(otherEntry.triggerSource).toBeNull();
    expect(otherEntry.sessionLink).toBeNull();

    // Ensure other user's secret prompt is not in the response
    const responseStr = JSON.stringify(data);
    expect(responseStr).not.toContain("secret-prompt-content");
  });

  it("only shows runs from the requested org", async () => {
    // Create runs in the default org
    await seedTestRun(user.userId, testComposeId, {
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
    await seedTestRun(user.userId, testComposeId, {
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
    await seedTestRun(user.userId, testComposeId, {
      status: "completed",
    });
    await seedTestRun(user.userId, testComposeId, {
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

  it("returns running tasks with privacy filtering", async () => {
    const otherUserId = uniqueId("other-user");

    await seedTestRun(user.userId, testComposeId, {
      status: "running",
    });
    await seedTestRun(otherUserId, testComposeId, {
      status: "running",
    });

    await insertUserCacheEntry({
      userId: user.userId,
      email: "alice@example.com",
    });
    await insertUserCacheEntry({
      userId: otherUserId,
      email: "bob@example.com",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runningTasks).toHaveLength(2);

    const ownTask = data.runningTasks.find((t: { isOwner: boolean }) => {
      return t.isOwner === true;
    });
    const otherTask = data.runningTasks.find((t: { isOwner: boolean }) => {
      return t.isOwner === false;
    });

    expect(ownTask.runId).toBeTruthy();
    expect(ownTask.agentName).toBeTruthy();
    expect(otherTask.runId).toBeNull();
  });

  it("returns null estimatedTimePerRun when no completed runs exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.estimatedTimePerRun).toBeNull();
  });

  it("returns empty runningTasks and queue arrays when none exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runningTasks).toEqual([]);
    expect(data.queue).toEqual([]);
    expect(data.estimatedTimePerRun).toBeNull();
  });

  it("computes estimatedTimePerRun from completed runs", async () => {
    const now = Date.now();

    // Create two completed runs with known durations (60s and 120s)
    await seedTestRun(user.userId, testComposeId, {
      status: "completed",
      startedAt: new Date(now - 120_000),
      completedAt: new Date(now - 60_000),
    });

    await seedTestRun(user.userId, testComposeId, {
      status: "completed",
      startedAt: new Date(now - 180_000),
      completedAt: new Date(now - 60_000),
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs/queue",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Run 1: 60s = 60000ms, Run 2: 120s = 120000ms, average = 90000ms
    expect(data.estimatedTimePerRun).toBe(90000);
  });

  it("produces sessionLink without /zero prefix for own runs with continuedFromSessionId", async () => {
    const sessionId = crypto.randomUUID();

    await seedTestRun(user.userId, testComposeId, {
      status: "queued",
      continuedFromSessionId: sessionId,
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
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].sessionLink).toBe(`/chat/${sessionId}`);
    expect(data.queue[0].sessionLink).not.toContain("/zero");
  });

  it("truncates long prompts at 200 characters for own runs", async () => {
    const longPrompt = "a".repeat(250);

    await seedTestRun(user.userId, testComposeId, {
      status: "queued",
      prompt: longPrompt,
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
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].isOwner).toBe(true);
    // Should be truncated to 200 chars + "..."
    expect(data.queue[0].prompt).toBe("a".repeat(200) + "...");
    expect(data.queue[0].prompt.length).toBe(203);
  });
});
