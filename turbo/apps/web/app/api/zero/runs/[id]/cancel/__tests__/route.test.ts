import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  insertTestChatThread,
  addTestRunToThread,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";
import { reloadEnv } from "../../../../../../../src/env";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcanc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function cancelUrl(runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}/cancel`;
}

describe("POST /api/zero/runs/:id/cancel", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should cancel a running run", async () => {
    const userId = uniqueId("zcanc-ok");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
    });

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(runId);
    expect(data.status).toBe("cancelled");
  });

  it("should return 400 when run already completed", async () => {
    const userId = uniqueId("zcanc-done");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "completed",
      completedAt: new Date(),
    });

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(400);
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("zcanc-nf");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(cancelUrl(randomUUID()), {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest("http://localhost:3000/api/zero/runs/some-id/cancel", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for sandbox token without agent-run:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1");

    const response = await POST(
      createTestRequest("http://localhost:3000/api/zero/runs/some-id/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:write");
  });

  it("should publish chatThreadRunUpdated when the run is linked to a chat thread", async () => {
    vi.stubEnv("ABLY_API_KEY", "test-key:test-secret");
    reloadEnv();
    mockAblyPublish.mockClear();

    const userId = uniqueId("zcanc-chat");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const threadId = await insertTestChatThread(
      userId,
      compose.composeId,
      "chat thread under cancel test",
    );
    // Seed a running run and attach it to the thread. addTestRunToThread
    // inserts a user message with runId=null (matching production) and sets
    // zero_runs.chatThreadId — the authoritative mapping the cancel path now
    // reads. The legacy reverse-lookup through chat_messages.runId would miss
    // this row (runId is null), which is the failure mode the fix targets.
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
    });
    await addTestRunToThread(threadId, runId, userId);

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    await context.mocks.flushAfter();

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `chatThreadRunUpdated:${threadId}`,
      null,
    );
  });
});
