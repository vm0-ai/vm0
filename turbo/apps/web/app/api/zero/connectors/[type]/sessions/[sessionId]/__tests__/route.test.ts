import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestConnectorSession,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zpoll");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function sessionUrl(type: string, sessionId: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}/sessions/${sessionId}`;
}

describe("GET /api/zero/connectors/:type/sessions/:sessionId", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return pending session status", async () => {
    const userId = uniqueId("zpoll-pend");
    await setupOrg(userId);
    const session = await createTestConnectorSession(userId, "github");

    const response = await GET(
      createTestRequest(sessionUrl("github", session.id)),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("pending");
  });

  it("should return completed session status", async () => {
    const userId = uniqueId("zpoll-done");
    await setupOrg(userId);
    const session = await createTestConnectorSession(userId, "github", {
      status: "complete",
      completedAt: new Date(),
    });

    const response = await GET(
      createTestRequest(sessionUrl("github", session.id)),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("complete");
  });

  it("should mark expired session and return expired status", async () => {
    const userId = uniqueId("zpoll-exp");
    await setupOrg(userId);
    const session = await createTestConnectorSession(userId, "github", {
      expiresAt: new Date(Date.now() - 1000), // Already expired
    });

    const response = await GET(
      createTestRequest(sessionUrl("github", session.id)),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("expired");
    expect(data.errorMessage).toBe("Session has expired");
  });

  it("should return 404 for non-existent session", async () => {
    const userId = uniqueId("zpoll-nf");
    await setupOrg(userId);

    const response = await GET(
      createTestRequest(
        sessionUrl("github", "00000000-0000-0000-0000-000000000000"),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        sessionUrl("github", "00000000-0000-0000-0000-000000000000"),
      ),
    );
    expect(response.status).toBe(401);
  });

  it("should not return another user's session", async () => {
    const userA = uniqueId("zpoll-a");
    await setupOrg(userA);
    const session = await createTestConnectorSession(userA, "github");

    // Switch to user B
    const userB = uniqueId("zpoll-b");
    await setupOrg(userB);

    const response = await GET(
      createTestRequest(sessionUrl("github", session.id)),
    );
    expect(response.status).toBe(404);
  });
});
