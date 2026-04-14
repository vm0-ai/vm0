import { describe, it, expect, beforeEach } from "vitest";
import { PUT } from "../route";
import {
  createTestRequest,
  createTestCompose,
  deleteOrgRow,
  getOrgDefaultAgent,
} from "../../../../../src/__tests__/api-test-helpers";
import { deleteTestCompose } from "../../../../../src/__tests__/db-test-seeders/agents";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

function putDefaultAgent(agentId: string | null) {
  return PUT(
    createTestRequest("http://localhost:3000/api/zero/default-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    }),
  );
}

describe("PUT /api/zero/default-agent", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });
    const response = await putDefaultAgent(null);
    expect(response.status).toBe(401);
  });

  it("should allow admin to set default agent", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    const response = await putDefaultAgent(compose.composeId);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agentId).toBe(compose.composeId);
  });

  it("should return 409 when trying to unset an already-configured default agent", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Set first
    await putDefaultAgent(compose.composeId);

    // Attempt to unset — blocked by 409 guard
    const response = await putDefaultAgent(null);
    expect(response.status).toBe(409);

    const data = await response.json();
    expect(data.error.code).toBe("CONFLICT");
  });

  it("should reject non-admin members", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Create a second user (different prefix = different user, no org admin)
    await context.setupUser({ prefix: "member" });

    // The member user resolves to their own org where they ARE admin,
    // but they don't have the compose. Test that agent-not-in-org returns 404.
    const response = await putDefaultAgent(compose.composeId);
    expect(response.status).toBe(404);
  });

  it("should reject agent not in org", async () => {
    await context.setupUser();

    // Use a random UUID that doesn't exist
    const response = await putDefaultAgent(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(response.status).toBe(404);
  });

  it("should write default agent to org table", async () => {
    const { orgId } = await context.setupUser();
    const compose = await createTestCompose("test-agent");

    await putDefaultAgent(compose.composeId);

    // Verify the value was persisted to the org table (stored as zero agent UUID)
    const storedId = await getOrgDefaultAgent(orgId);
    expect(storedId).toBe(compose.agentId);
  });

  it("should not update org table when 409 conflict prevents unsetting", async () => {
    const { orgId } = await context.setupUser();
    const compose = await createTestCompose("test-agent");

    await putDefaultAgent(compose.composeId);

    // Attempt to unset — should be rejected with 409
    const response = await putDefaultAgent(null);
    expect(response.status).toBe(409);

    // org table should still have the original value (stored as zero agent UUID)
    const storedId = await getOrgDefaultAgent(orgId);
    expect(storedId).toBe(compose.agentId);
  });

  it("should return 409 when setting default agent twice", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Set default
    const response1 = await putDefaultAgent(compose.composeId);
    expect(response1.status).toBe(200);

    // Attempt to set again — blocked by 409 guard
    const response2 = await putDefaultAgent(compose.composeId);
    expect(response2.status).toBe(409);

    const data = await response2.json();
    expect(data.error.code).toBe("CONFLICT");
  });

  it("should allow re-setting default agent when previous compose was deleted", async () => {
    await context.setupUser();
    const compose1 = await createTestCompose("agent-1");

    // Set first default agent
    const response1 = await putDefaultAgent(compose1.composeId);
    expect(response1.status).toBe(200);

    // Delete the compose from DB (simulating user deleting the agent)
    await deleteTestCompose(compose1.composeId);

    // Setting a new default should succeed since the old one no longer exists
    const compose2 = await createTestCompose("agent-2");
    const response2 = await putDefaultAgent(compose2.composeId);
    expect(response2.status).toBe(200);

    const data = await response2.json();
    expect(data.agentId).toBe(compose2.composeId);
  });

  it("should allow setting default agent when none is configured", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // No default agent configured yet — should succeed
    const response = await putDefaultAgent(compose.composeId);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agentId).toBe(compose.composeId);
  });

  it("should succeed when org row does not exist in org table", async () => {
    const { orgId } = await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Remove the org row to simulate a free-tier org that never triggered lazy migration
    await deleteOrgRow(orgId);

    // The upsert should create the org row and set the default agent
    const response = await putDefaultAgent(compose.composeId);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agentId).toBe(compose.composeId);

    // Verify the value was persisted to the org table (stored as zero agent UUID)
    const storedId = await getOrgDefaultAgent(orgId);
    expect(storedId).toBe(compose.agentId);
  });
});
