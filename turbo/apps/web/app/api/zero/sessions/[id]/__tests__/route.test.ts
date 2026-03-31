import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestAgentSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsess");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function sessionUrl(sessionId: string): string {
  return `http://localhost:3000/api/zero/sessions/${sessionId}`;
}

describe("GET /api/zero/sessions/:id", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return session details", async () => {
    const userId = uniqueId("zsess-get");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zsess")}`);
    const session = await createTestAgentSession(userId, compose.composeId);

    const response = await GET(createTestRequest(sessionUrl(session.id)));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(session.id);
    expect(data.agentId).toBe(compose.composeId);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should return 404 when session not found", async () => {
    const userId = uniqueId("zsess-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(sessionUrl(randomUUID())));
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/sessions/some-id"),
    );
    expect(response.status).toBe(401);
  });
});
