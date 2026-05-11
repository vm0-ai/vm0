import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { PATCH } from "../route";
import { GET as LIST } from "../../../list/route";
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

async function findComposeMetadata(composeId: string): Promise<{
  displayName: string | null;
  description: string | null;
  sound: string | null;
}> {
  const response = await LIST(
    createTestRequest("http://localhost:3000/api/zero/composes/list"),
  );
  expect(response.status).toBe(200);
  const data = await response.json();
  const compose = data.composes.find((item: { id: string }) => {
    return item.id === composeId;
  });
  if (!compose) {
    throw new Error(`Expected compose ${composeId} in list response`);
  }
  return {
    displayName: compose.displayName,
    description: compose.description,
    sound: compose.sound,
  };
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
    await expect(findComposeMetadata(compose.composeId)).resolves.toStrictEqual(
      {
        displayName: "Test Display Name",
        description: "Test description",
        sound: null,
      },
    );
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
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
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
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should return 401 when the authenticated session has no active organization", async () => {
    mockClerk({ userId: uniqueId("zmeta-no-org"), orgId: null });

    const response = await PATCH(
      createTestRequest(metadataUrl(randomUUID()), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Test" }),
      }),
      { params: Promise.resolve({ id: randomUUID() }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should allow a non-owner same-org member to update metadata", async () => {
    const ownerUserId = uniqueId("zmeta-owner");
    await setupOrg(ownerUserId);
    const compose = await createTestCompose(`agent-${uniqueId("zmeta")}`);

    mockClerk({
      userId: uniqueId("zmeta-member"),
      orgId: `org_mock_${ownerUserId}`,
      orgRole: "org:member",
    });

    const response = await PATCH(
      createTestRequest(metadataUrl(compose.composeId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Member Display" }),
      }),
      { params: Promise.resolve({ id: compose.composeId }) },
    );

    expect(response.status).toBe(200);
    await expect(findComposeMetadata(compose.composeId)).resolves.toMatchObject(
      {
        displayName: "Member Display",
      },
    );
  });

  it("should return 404 for a compose in another org without mutating metadata", async () => {
    const ownerUserId = uniqueId("zmeta-cross-owner");
    await setupOrg(ownerUserId);
    const compose = await createTestCompose(`agent-${uniqueId("zmeta")}`);
    await PATCH(
      createTestRequest(metadataUrl(compose.composeId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Owner Display",
          description: "Owner description",
          sound: "owner-sound",
        }),
      }),
      { params: Promise.resolve({ id: compose.composeId }) },
    );

    await setupOrg(uniqueId("zmeta-cross-attacker"));

    const response = await PATCH(
      createTestRequest(metadataUrl(compose.composeId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Hacked" }),
      }),
      { params: Promise.resolve({ id: compose.composeId }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    mockClerk({
      userId: ownerUserId,
      orgId: `org_mock_${ownerUserId}`,
      orgRole: "org:admin",
    });
    await expect(findComposeMetadata(compose.composeId)).resolves.toStrictEqual(
      {
        displayName: "Owner Display",
        description: "Owner description",
        sound: "owner-sound",
      },
    );
  });

  it("should preserve unprovided metadata fields on partial update", async () => {
    const userId = uniqueId("zmeta-partial");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zmeta")}`);

    await PATCH(
      createTestRequest(metadataUrl(compose.composeId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Initial Display",
          description: "Initial description",
          sound: "initial-sound",
        }),
      }),
      { params: Promise.resolve({ id: compose.composeId }) },
    );

    const response = await PATCH(
      createTestRequest(metadataUrl(compose.composeId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Updated Display" }),
      }),
      { params: Promise.resolve({ id: compose.composeId }) },
    );

    expect(response.status).toBe(200);
    await expect(findComposeMetadata(compose.composeId)).resolves.toStrictEqual(
      {
        displayName: "Updated Display",
        description: "Initial description",
        sound: "initial-sound",
      },
    );
  });
});
