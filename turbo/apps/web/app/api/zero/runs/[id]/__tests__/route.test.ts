import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
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
  const slug = uniqueId("zrun");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function runUrl(slug: string, runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}?org=${slug}`;
}

describe("GET /api/zero/runs/:id", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return run details", async () => {
    const userId = uniqueId("zrun-get");
    const { slug } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zrun")}`);
    const { runId } = await createTestRunInDb(userId, compose.composeId, {
      status: "running",
      prompt: "test prompt",
    });

    const response = await GET(createTestRequest(runUrl(slug, runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.runId).toBe(runId);
    expect(data.status).toBe("running");
    expect(data.prompt).toBe("test prompt");
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("zrun-nf");
    const { slug } = await setupOrg(userId);

    const response = await GET(createTestRequest(runUrl(slug, randomUUID())));
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/runs/some-id?org=test"),
    );
    expect(response.status).toBe(401);
  });
});
