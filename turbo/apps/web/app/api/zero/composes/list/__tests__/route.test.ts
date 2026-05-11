import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestSandboxToken,
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
    const first = await createTestCompose(`agent-${uniqueId("zlist-first")}`);
    const second = await createTestCompose(`agent-${uniqueId("zlist-second")}`);

    const response = await GET(createTestRequest(listUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(
      data.composes.map((compose: { name: string }) => {
        return compose.name;
      }),
    ).toEqual([second.name, first.name]);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/zero/composes/list"),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should return 400 when the authenticated session has no active organization", async () => {
    mockClerk({ userId: uniqueId("zlist-no-org"), orgId: null });

    const response = await GET(createTestRequest(listUrl()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });
  });

  it("should not include composes from other orgs", async () => {
    const userId = uniqueId("zlist-own");
    await setupOrg(userId);
    const ownCompose = await createTestCompose(
      `agent-${uniqueId("zlist-own")}`,
    );

    await setupOrg(uniqueId("zlist-other"));
    const otherCompose = await createTestCompose(
      `agent-${uniqueId("zlist-other")}`,
    );

    mockClerk({
      userId,
      orgId: `org_mock_${userId}`,
      orgRole: "org:admin",
    });

    const response = await GET(createTestRequest(listUrl()));
    expect(response.status).toBe(200);

    const data = await response.json();
    const ids = data.composes.map((compose: { id: string }) => {
      return compose.id;
    });
    expect(ids).toContain(ownCompose.composeId);
    expect(ids).not.toContain(otherCompose.composeId);
  });

  it("should accept sandbox tokens", async () => {
    mockClerk({ userId: null });
    const token = await createTestSandboxToken(
      uniqueId("zlist-sandbox"),
      `run_${uniqueId("zlist")}`,
    );

    const response = await GET(
      createTestRequest(listUrl(), {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ composes: [] });
  });
});
