import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import {
  addTestRunToThread,
  insertTestChatThread,
  setTestChatThreadPendingMessage,
} from "../../../../../../../src/__tests__/db-test-seeders/agents";
import { getTestChatThreadPendingMessage } from "../../../../../../../src/__tests__/db-test-assertions/agents";

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

  it("should return 400 with RUN_NOT_CANCELLABLE when run already completed", async () => {
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

    const data = await response.json();
    expect(data.error.code).toBe("RUN_NOT_CANCELLABLE");
    expect(data.error.message).toContain("cannot be cancelled");
  });

  it("should return 200 when run is already cancelled (idempotent)", async () => {
    const userId = uniqueId("zcanc-idem");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "cancelled",
      completedAt: new Date(),
    });

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(runId);
    expect(data.status).toBe("cancelled");
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
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000/cancel",
        {
          method: "POST",
        },
      ),
    );
    expect(response.status).toBe(401);
  });

  it("should cancel a running run while the thread has a queued pending message", async () => {
    // The Stop button on the composer recalls the queued message into the
    // draft and then calls this cancel endpoint. The recall and cancel
    // round-trips race in practice, so the cancel route must succeed even
    // when the thread row still carries pending_message_* columns at the
    // moment the request lands.
    const userId = uniqueId("zcanc-pend");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const threadId = await insertTestChatThread(
      userId,
      compose.composeId,
      "Cancel with pending",
    );
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
      chatThreadId: threadId,
    });
    await addTestRunToThread(threadId, runId, userId);
    await setTestChatThreadPendingMessage(threadId, {
      content: "draft to recall",
      attachments: null,
    });

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(runId);
    expect(data.status).toBe("cancelled");

    // Cancel does not touch pending_message_* columns — that responsibility
    // belongs to the recall endpoint the client invokes alongside this one.
    const pending = await getTestChatThreadPendingMessage(threadId);
    expect(pending?.pendingMessageContent).toBe("draft to recall");
    expect(pending?.pendingMessageCreatedAt).not.toBeNull();
  });

  it("should return 403 for sandbox token without agent-run:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1", "org-test");

    const response = await POST(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000/cancel",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:write");
  });
});
