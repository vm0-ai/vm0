import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { PATCH } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zmeta");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function metadataUrl(composeId: string): string {
  return `http://localhost:3000/api/zero/composes/${composeId}/metadata`;
}

describe("PATCH /api/zero/composes/:id/metadata", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should update compose metadata", async () => {
    const userId = uniqueId("zmeta-upd");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zmeta")}`);

    const response = await PATCH(
      createTestRequest(metadataUrl(compose.composeId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Test Display Name",
          description: "Test description",
        }),
      }),
      { params: Promise.resolve({ id: compose.composeId }) },
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);
  });

  it("should return 404 when compose not found", async () => {
    const userId = uniqueId("zmeta-nf");
    await setupOrg(userId);

    const response = await PATCH(
      createTestRequest(metadataUrl(randomUUID()), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Test" }),
      }),
      { params: Promise.resolve({ id: randomUUID() }) },
    );
    expect(response.status).toBe(404);
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await PATCH(
      createTestRequest(metadataUrl("some-id"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Test" }),
      }),
      { params: Promise.resolve({ id: "some-id" }) },
    );
    expect(response.status).toBe(401);
  });
});
