import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
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
  const slug = uniqueId("zrun");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function runUrl(runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}`;
}

describe("GET /api/zero/runs/:id", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return run details", async () => {
    const userId = uniqueId("zrun-get");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zrun")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
      prompt: "test prompt",
    });

    const response = await GET(createTestRequest(runUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.runId).toBe(runId);
    expect(data.status).toBe("running");
    expect(data.prompt).toBe("test prompt");
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("zrun-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(runUrl(randomUUID())));
    expect(response.status).toBe(404);
  });

  // Regression for #11126: short non-UUID id used to flow into drizzle and
  // surface as a postgres `22P02 invalid input syntax for type uuid` 500.
  it("should return 400 when id is not a valid UUID", async () => {
    const userId = uniqueId("zrun-bad");
    await setupOrg(userId);

    const response = await GET(createTestRequest(runUrl("2b9b2303")));
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000",
      ),
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for sandbox token without agent-run:read capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1", "org-test");

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/runs/00000000-0000-0000-0000-000000000000",
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:read");
  });
});
