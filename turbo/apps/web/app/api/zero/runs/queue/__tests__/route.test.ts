import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRunInDb,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zqueue");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function queueUrl(slug: string): string {
  return `http://localhost:3000/api/zero/runs/queue?org=${slug}`;
}

describe("GET /api/zero/runs/queue", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return queue status with concurrency info", async () => {
    const userId = uniqueId("zqueue-get");
    const { slug } = await setupOrg(userId);

    const response = await GET(createTestRequest(queueUrl(slug)));
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
    const { slug } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zqueue")}`);
    await createTestRunInDb(userId, compose.composeId, {
      status: "running",
    });

    const response = await GET(createTestRequest(queueUrl(slug)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.concurrency.active).toBe(1);
    expect(data.runningTasks).toHaveLength(1);
    expect(data.runningTasks[0].isOwner).toBe(true);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/runs/queue?org=test"),
    );
    expect(response.status).toBe(401);
  });
});
