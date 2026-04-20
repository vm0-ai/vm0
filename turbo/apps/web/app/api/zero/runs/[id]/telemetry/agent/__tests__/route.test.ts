import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("ztele");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function telemetryUrl(runId: string): string {
  return `http://localhost:3000/api/zero/runs/${runId}/telemetry/agent?limit=10&order=desc`;
}

describe("GET /api/zero/runs/:id/telemetry/agent", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return agent events for a run", async () => {
    const userId = uniqueId("ztele-get");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("ztele")}`);
    const { runId } = await seedTestRun(userId, compose.composeId, {
      status: "running",
    });

    context.mocks.axiom.queryAxiom.mockResolvedValue([]);

    const response = await GET(createTestRequest(telemetryUrl(runId)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.events).toEqual([]);
    expect(data.hasMore).toBe(false);
    expect(data.framework).toBeDefined();
  });

  it("should return 404 when run not found", async () => {
    const userId = uniqueId("ztele-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(telemetryUrl(randomUUID())));
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/runs/${randomUUID()}/telemetry/agent?limit=10&order=desc`,
      ),
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for sandbox token without agent-run:read capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1");

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/runs/${randomUUID()}/telemetry/agent?limit=10&order=desc`,
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
