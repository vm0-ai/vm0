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

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zlist");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function listUrl(): string {
  return `http://localhost:3000/api/zero/composes/list`;
}

describe("GET /api/zero/composes/list", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return empty list", async () => {
    const userId = uniqueId("zlist-empty");
    await setupOrg(userId);

    const response = await GET(createTestRequest(listUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.composes).toEqual([]);
  });

  it("should return list with composes", async () => {
    const userId = uniqueId("zlist-has");
    await setupOrg(userId);
    await createTestCompose(`agent-${uniqueId("zlist")}`);

    const response = await GET(createTestRequest(listUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.composes.length).toBeGreaterThanOrEqual(1);
    expect(data.composes[0].name).toBeDefined();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/composes/list"),
    );
    expect(response.status).toBe(401);
  });
});
