import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET, DELETE } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zcompid");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function composeIdUrl(composeId: string): string {
  return `http://localhost:3000/api/zero/composes/${composeId}`;
}

describe("GET /api/zero/composes/:id", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return compose by id", async () => {
    const userId = uniqueId("zcompid-get");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcompid")}`);

    const response = await GET(
      createTestRequest(composeIdUrl(compose.composeId)),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe(compose.composeId);
    expect(data.name).toBe(compose.name);
  });

  it("should return 404 when compose not found", async () => {
    const userId = uniqueId("zcompid-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(composeIdUrl(randomUUID())));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });

  it("should return 400 for malformed compose id", async () => {
    const userId = uniqueId("zcompid-bad-id");
    await setupOrg(userId);

    const response = await GET(
      createTestRequest(composeIdUrl("91fc0bd84bba673393d9adfc1a0f4dec")),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
    expect(data.error.message).toContain("valid UUID");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(composeIdUrl(randomUUID())));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should return 401 when the authenticated session has no active organization", async () => {
    mockClerk({ userId: uniqueId("zcompid-no-org"), orgId: null });

    const response = await GET(createTestRequest(composeIdUrl(randomUUID())));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should return 404 for a compose owned by another org", async () => {
    const ownerUserId = uniqueId("zcompid-owner");
    await setupOrg(ownerUserId);
    const compose = await createTestCompose(`agent-${uniqueId("zcompid")}`);

    await setupOrg(uniqueId("zcompid-other"));

    const response = await GET(
      createTestRequest(composeIdUrl(compose.composeId)),
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
    const ownerResponse = await GET(
      createTestRequest(composeIdUrl(compose.composeId)),
    );
    expect(ownerResponse.status).toBe(200);
  });
});

describe("DELETE /api/zero/composes/:id", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should delete a compose", async () => {
    const userId = uniqueId("zcompid-del");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcompid")}`);

    const response = await DELETE(
      createTestRequest(composeIdUrl(compose.composeId), { method: "DELETE" }),
    );
    expect(response.status).toBe(204);
  });

  it("should return 404 when compose not found", async () => {
    const userId = uniqueId("zcompid-delnf");
    await setupOrg(userId);

    const response = await DELETE(
      createTestRequest(composeIdUrl(randomUUID()), { method: "DELETE" }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(
      createTestRequest(composeIdUrl(randomUUID()), { method: "DELETE" }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should return 404 when another user owns the compose", async () => {
    const ownerUserId = uniqueId("zcompid-owner-del");
    await setupOrg(ownerUserId);
    const compose = await createTestCompose(`agent-${uniqueId("zcompid")}`);

    await setupOrg(uniqueId("zcompid-attacker"));

    const response = await DELETE(
      createTestRequest(composeIdUrl(compose.composeId), { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    mockClerk({
      userId: ownerUserId,
      orgId: `org_mock_${ownerUserId}`,
      orgRole: "org:admin",
    });
    const ownerResponse = await GET(
      createTestRequest(composeIdUrl(compose.composeId)),
    );
    expect(ownerResponse.status).toBe(200);
  });

  it("should return 409 when a pending run references the compose", async () => {
    const userId = uniqueId("zcompid-running");
    await setupOrg(userId);
    const compose = await createTestCompose(`agent-${uniqueId("zcompid")}`);
    await createTestRun(compose.composeId, "blocking run");

    const response = await DELETE(
      createTestRequest(composeIdUrl(compose.composeId), { method: "DELETE" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });
  });
});
