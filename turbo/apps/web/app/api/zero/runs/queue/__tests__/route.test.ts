import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zqueue");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function queueUrl(): string {
  return `http://localhost:3000/api/zero/runs/queue`;
}

describe("GET /api/zero/runs/queue", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return queue status with concurrency info", async () => {
    const userId = uniqueId("zqueue-get");
    await setupOrg(userId);

    const response = await GET(createTestRequest(queueUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.concurrency).toBeDefined();
    expect(data.concurrency.tier).toBeDefined();
    expect(typeof data.concurrency.limit).toBe("number");
    expect(typeof data.concurrency.active).toBe("number");
    expect(data.queue).toEqual([]);
    expect(data.runningTasks).toEqual([]);
    expect(data.estimatedTimePerRun).toBeNull();
  });

  it("should include running tasks in response", async () => {
    const userId = uniqueId("zqueue-run");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zqueue")}`);
    await seedTestRun(userId, compose.composeId, {
      status: "running",
    });

    const response = await GET(createTestRequest(queueUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.concurrency.active).toBe(1);
    expect(data.runningTasks).toHaveLength(1);
    expect(data.runningTasks[0].isOwner).toBe(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/runs/queue"),
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for sandbox token without agent-run:read capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1");

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/runs/queue", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:read");
  });
});
