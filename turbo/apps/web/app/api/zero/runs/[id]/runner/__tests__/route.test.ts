import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
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
import {
  seedTestRun,
  setTestRunSandboxReuseResult,
} from "../../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zrun");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function runnerUrl(runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}/runner`;
}

describe("GET /api/zero/runs/:id/runner", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns sandboxReuseResult when set", async () => {
    const userId = uniqueId("zrun-set");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zrun")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "completed",
    });
    await setTestRunSandboxReuseResult(runId, "reused");

    const response = await GET(createTestRequest(runnerUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.sandboxReuseResult).toBe("reused");
  });

  it("returns null sandboxReuseResult for older runs", async () => {
    const userId = uniqueId("zrun-null");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zrun")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "completed",
    });

    const response = await GET(createTestRequest(runnerUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.sandboxReuseResult).toBeNull();
  });

  it("returns 404 when run not found", async () => {
    const userId = uniqueId("zrun-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(runnerUrl(randomUUID())));
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when run belongs to a different user", async () => {
    const ownerId = uniqueId("zrun-own");
    await setupOrg(ownerId);
    const compose = await createTestCompose(`agent-${uniqueId("zrun")}`);
    const { runId } = await seedTestRun(ownerId, compose.composeId, {
      status: "completed",
    });
    await setTestRunSandboxReuseResult(runId, "poolMiss");

    const otherUserId = uniqueId("zrun-oth");
    await setupOrg(otherUserId);

    const response = await GET(createTestRequest(runnerUrl(runId)));
    expect(response.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000/runner",
      ),
    );
    expect(response.status).toBe(401);
  });
});
