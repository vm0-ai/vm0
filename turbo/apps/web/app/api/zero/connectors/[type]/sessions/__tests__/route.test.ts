import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zsess");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function sessionsUrl(type: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}/sessions`;
}

describe("POST /api/zero/connectors/:type/sessions", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should create a connector session", async () => {
    const userId = uniqueId("zsess-create");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(sessionsUrl("github"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(data.type).toBe("github");
    expect(data.status).toBe("pending");
    expect(data.verificationUrl).toContain(
      "/api/zero/connectors/github/authorize",
    );
    expect(data.verificationUrl).toContain(`session=${data.id}`);
    expect(data.expiresIn).toBe(900);
    expect(data.interval).toBe(5);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(sessionsUrl("github"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });
});
