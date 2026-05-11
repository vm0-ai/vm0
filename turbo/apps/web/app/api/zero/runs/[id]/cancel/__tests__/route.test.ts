import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  enqueueTestRun,
  findTestQueueEntry,
  findTestRunRecord,
  insertTestModelUsageEventForRun,
  findTestUsageEvent,
  setOrgCredits,
  getOrgCredits,
  insertTestUsagePricing,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";

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

  it("should drain the org queue after cancelling a running run", async () => {
    const userId = uniqueId("zcanc-drain-running");
    const { orgId } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
    });
    const queued = await enqueueTestRun({
      userId,
      agentComposeVersionId: compose.versionId,
      orgId,
      composeId: compose.composeId,
      prompt: "queued after running cancel",
    });

    await expect(findTestQueueEntry(queued.runId)).resolves.toBeDefined();

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const queuedRun = await findTestRunRecord(queued.runId);
    expect(queuedRun?.status).toBe("pending");
    await expect(findTestQueueEntry(queued.runId)).resolves.toBeUndefined();
  });

  it("should drain the org queue after cancelling a queued run", async () => {
    const userId = uniqueId("zcanc-drain-queued");
    const { orgId } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const cancelled = await enqueueTestRun({
      userId,
      agentComposeVersionId: compose.versionId,
      orgId,
      composeId: compose.composeId,
      prompt: "queued run to cancel",
    });
    const nextQueued = await enqueueTestRun({
      userId,
      agentComposeVersionId: compose.versionId,
      orgId,
      composeId: compose.composeId,
      prompt: "next queued run",
    });

    const response = await POST(
      createTestRequest(cancelUrl(cancelled.runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const cancelledRun = await findTestRunRecord(cancelled.runId);
    expect(cancelledRun?.status).toBe("cancelled");
    await expect(findTestQueueEntry(cancelled.runId)).resolves.toBeUndefined();

    const nextRun = await findTestRunRecord(nextQueued.runId);
    expect(nextRun?.status).toBe("pending");
    await expect(findTestQueueEntry(nextQueued.runId)).resolves.toBeUndefined();
  });

  it("should not drain the org queue when cancellation is idempotent", async () => {
    const userId = uniqueId("zcanc-no-drain-idem");
    const { orgId } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "cancelled",
      completedAt: new Date(),
    });
    const queued = await enqueueTestRun({
      userId,
      agentComposeVersionId: compose.versionId,
      orgId,
      composeId: compose.composeId,
      prompt: "queued should remain queued",
    });

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const queuedRun = await findTestRunRecord(queued.runId);
    expect(queuedRun?.status).toBe("queued");
    await expect(findTestQueueEntry(queued.runId)).resolves.toBeDefined();
  });

  it("should process pending usage events after cancelling a running run", async () => {
    const userId = uniqueId("zcanc-credit-running");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 1000);
    await insertTestUsagePricing({
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 5000,
    });
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
    });
    const { id: usageEventId } = await insertTestModelUsageEventForRun({
      runId,
      orgId,
      userId,
      inputTokens: 5000,
      outputTokens: 0,
      status: "pending",
    });

    const response = await POST(
      createTestRequest(cancelUrl(runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const usageEvent = await findTestUsageEvent(usageEventId);
    expect(usageEvent?.status).toBe("processed");
    expect(usageEvent?.creditsCharged).toBe(1);
    await expect(getOrgCredits(orgId)).resolves.toBe(999);
  });

  it("should not process pending usage events after cancelling a queued run", async () => {
    const userId = uniqueId("zcanc-credit-queued");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 1000);
    await insertTestUsagePricing({
      kind: "model",
      provider: "claude-sonnet-4-6",
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 5000,
    });
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const queued = await enqueueTestRun({
      userId,
      agentComposeVersionId: compose.versionId,
      orgId,
      composeId: compose.composeId,
      prompt: "queued with pending usage",
    });
    const { id: usageEventId } = await insertTestModelUsageEventForRun({
      runId: queued.runId,
      orgId,
      userId,
      inputTokens: 5000,
      outputTokens: 0,
      status: "pending",
    });

    const response = await POST(
      createTestRequest(cancelUrl(queued.runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const usageEvent = await findTestUsageEvent(usageEventId);
    expect(usageEvent?.status).toBe("pending");
    expect(usageEvent?.creditsCharged).toBeNull();
    await expect(getOrgCredits(orgId)).resolves.toBe(1000);
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

  it("should return 401 when the authenticated session has no active organization", async () => {
    mockClerk({ userId: uniqueId("zcanc-no-org"), orgId: null });

    const response = await POST(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000/cancel",
        {
          method: "POST",
        },
      ),
    );
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
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
