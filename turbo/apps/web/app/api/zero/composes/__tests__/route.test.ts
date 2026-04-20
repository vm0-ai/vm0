import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcomp");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function composeUrl(slug: string, name: string): string {
  return `http://localhost:3000/api/zero/composes?name=${name}&org=${slug}`;
}

describe("GET /api/zero/composes (getByName)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return compose by name", async () => {
    const userId = uniqueId("zcomp-get");
    const { slug } = await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcomp")}`);

    const response = await GET(
      createTestRequest(composeUrl(slug, compose.name)),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.name).toBe(compose.name);
  });

  it("should return 404 when compose not found", async () => {
    const userId = uniqueId("zcomp-nf");
    const { slug } = await setupOrg(userId);

    const response = await GET(
      createTestRequest(composeUrl(slug, "nonexistent-agent")),
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/composes?name=test&org=test",
      ),
    );
    expect(response.status).toBe(401);
  });
});
