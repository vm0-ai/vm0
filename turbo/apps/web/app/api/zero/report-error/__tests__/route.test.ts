import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRunInDb,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const URL = "http://localhost:3000/api/zero/report-error";
const context = testContext();

async function setupFailedRun(userId: string) {
  const compose = await createTestCompose(`agent-${uniqueId("rpt")}`);
  const { runId } = await createTestRunInDb(userId, compose.composeId, {
    status: "failed",
  });
  return { runId, composeId: compose.composeId };
}

function postReportError(body: Record<string, unknown>) {
  return POST(
    createTestRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/report-error", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    userId = uniqueId("rpt-user");
    const slug = uniqueId("rpt-org");
    orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    await createTestOrg(slug);
  });

  it("should submit error report for a failed run", async () => {
    const { runId } = await setupFailedRun(userId);

    const response = await postReportError({ runId });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.reference).toBeDefined();
    expect(data.reference).toMatch(/^er-[a-f0-9]{8}$/);
  });

  it("should return 400 for non-existent run", async () => {
    const response = await postReportError({ runId: randomUUID() });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe("RUN_NOT_FOUND");
  });

  it("should return 400 for non-failed run", async () => {
    const compose = await createTestCompose(`agent-${uniqueId("rpt")}`);
    const { runId } = await createTestRunInDb(userId, compose.composeId, {
      status: "completed",
    });

    const response = await postReportError({ runId });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe("RUN_NOT_FAILED");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await postReportError({ runId: randomUUID() });
    expect(response.status).toBe(401);
  });

  it("should return 403 for run in different org", async () => {
    // Create a run under a different user/org
    const otherUserId = uniqueId("rpt-other");
    const otherSlug = uniqueId("rpt-other-org");
    // Temporarily mock as other user to create the org and compose
    mockClerk({
      userId: otherUserId,
      orgId: `org_mock_${otherUserId}`,
      orgRole: "org:admin",
    });
    await createTestOrg(otherSlug);
    const { runId } = await setupFailedRun(otherUserId);

    // Switch back to original user
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postReportError({ runId });
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });
});
