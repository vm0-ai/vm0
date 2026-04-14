import { describe, it, expect, beforeEach } from "vitest";
import { PATCH } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../../../src/__tests__/db-test-seeders/agents";
import { getTestZeroAgent } from "../../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

async function callPatch(
  composeId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const request = createTestRequest(
    `http://localhost:3000/api/agent/composes/${composeId}/metadata`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
  return PATCH(request);
}

describe("PATCH /api/agent/composes/:id/metadata", () => {
  let user: { userId: string; orgId: string };

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should create zero_agents row when none exists", async () => {
    const agentName = uniqueId("meta-agent");
    const { composeId } = await createTestCompose(agentName);

    const response = await callPatch(composeId, {
      displayName: "My Agent",
      description: "A test agent",
      sound: "friendly",
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ ok: true });

    // Verify the row was created
    const row = await getTestZeroAgent(user.orgId, agentName);
    expect(row).toBeDefined();
    expect(row!.displayName).toBe("My Agent");
    expect(row!.description).toBe("A test agent");
    expect(row!.sound).toBe("friendly");
  });

  it("should update existing zero_agents row", async () => {
    const agentName = uniqueId("meta-agent");
    const { composeId } = await createTestCompose(agentName);

    // Seed initial metadata
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "Old Name",
      description: "Old description",
    });

    const response = await callPatch(composeId, {
      displayName: "New Name",
    });

    expect(response.status).toBe(200);

    // Verify the row was updated (only displayName changed)
    const row = await getTestZeroAgent(user.orgId, agentName);
    expect(row).toBeDefined();
    expect(row!.displayName).toBe("New Name");
    // description should remain from initial seed (onConflict only updates provided fields)
    expect(row!.description).toBe("Old description");
  });

  it("should return 400 for invalid body", async () => {
    const agentName = uniqueId("meta-agent");
    const { composeId } = await createTestCompose(agentName);

    const response = await callPatch(composeId, {
      displayName: 12345,
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 for nonexistent compose", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";

    const response = await callPatch(fakeId, {
      displayName: "Test",
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 404 for compose owned by another org", async () => {
    const agentName = uniqueId("meta-agent");
    const { composeId } = await createTestCompose(agentName);

    // Switch to a different user/org
    await context.setupUser({ prefix: "other-user" });

    const response = await callPatch(composeId, {
      displayName: "Hacked Name",
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should allow partial updates", async () => {
    const agentName = uniqueId("meta-agent");
    const { composeId } = await createTestCompose(agentName);

    // Only update sound
    const response = await callPatch(composeId, {
      sound: "energetic",
    });

    expect(response.status).toBe(200);

    const row = await getTestZeroAgent(user.orgId, agentName);
    expect(row).toBeDefined();
    expect(row!.sound).toBe("energetic");
    expect(row!.displayName).toBeNull();
    expect(row!.description).toBeNull();
  });

  it("should allow same-org member to update metadata", async () => {
    const agentName = uniqueId("meta-agent");
    const { composeId } = await createTestCompose(agentName);

    // Switch to another user in the same org
    mockClerk({
      userId: "other-member-123",
      orgId: user.orgId,
      clerkOrgs: [{ id: user.orgId, slug: "shared-org", name: "Shared Org" }],
    });

    const response = await callPatch(composeId, {
      displayName: "Updated by member",
    });

    expect(response.status).toBe(200);
  });
});
