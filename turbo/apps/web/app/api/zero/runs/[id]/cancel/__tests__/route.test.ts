import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRunInDb,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcanc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function cancelUrl(slug: string, runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}/cancel?org=${slug}`;
}

describe("POST /api/zero/runs/:id/cancel", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should cancel a running run", async () => {
    const userId = uniqueId("zcanc-ok");
    const { slug } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await createTestRunInDb(userId, compose.composeId, {
      status: "running",
    });

    const response = await POST(
      createTestRequest(cancelUrl(slug, runId), { method: "POST" }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(runId);
    expect(data.status).toBe("cancelled");
  });

  it("should return 400 when run already completed", async () => {
    const userId = uniqueId("zcanc-done");
    const { slug } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcanc")}`);
    const { runId } = await createTestRunInDb(userId, compose.composeId, {
      status: "completed",
      completedAt: new Date(),
    });

    const response = await POST(
      createTestRequest(cancelUrl(slug, runId), { method: "POST" }),
    );
    expect(response.status).toBe(400);
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("zcanc-nf");
    const { slug } = await setupOrg(userId);

    const response = await POST(
      createTestRequest(cancelUrl(slug, randomUUID()), {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/some-id/cancel?org=test",
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(401);
  });
});
