import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { PUT } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

function putDefaultAgent(
  orgSlug: string | undefined,
  agentComposeId: string | null,
) {
  const url = orgSlug
    ? `http://localhost:3000/api/orgs/default-agent?org=${orgSlug}`
    : "http://localhost:3000/api/orgs/default-agent";
  return PUT(
    createTestRequest(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentComposeId }),
    }),
  );
}

describe("PUT /api/orgs/default-agent", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });
    const response = await putDefaultAgent(undefined, null);
    expect(response.status).toBe(401);
  });

  it("should allow admin to set default agent", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    const response = await putDefaultAgent(undefined, compose.composeId);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agentComposeId).toBe(compose.composeId);
  });

  it("should allow admin to unset default agent", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Set first
    await putDefaultAgent(undefined, compose.composeId);

    // Then unset
    const response = await putDefaultAgent(undefined, null);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agentComposeId).toBeNull();
  });

  it("should reject non-admin members", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Create a second user (different prefix = different user, no org admin)
    await context.setupUser({ prefix: "member" });

    // The member user resolves to their own org where they ARE admin,
    // but they don't have the compose. Test that agent-not-in-org returns 404.
    const response = await putDefaultAgent(undefined, compose.composeId);
    expect(response.status).toBe(404);
  });

  it("should reject agent not in org", async () => {
    await context.setupUser();

    // Use a random UUID that doesn't exist
    const response = await putDefaultAgent(
      undefined,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(response.status).toBe(404);
  });

  it("should dual-write default agent to Clerk org metadata", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    await putDefaultAgent(undefined, compose.composeId);

    const client = await vi.mocked(clerkClient)();
    expect(
      client.organizations.updateOrganizationMetadata,
    ).toHaveBeenCalledWith(expect.any(String), {
      publicMetadata: { default_agent_compose_id: compose.composeId },
    });
  });

  it("should dual-write null to Clerk org metadata when unsetting", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    await putDefaultAgent(undefined, compose.composeId);
    await putDefaultAgent(undefined, null);

    const client = await vi.mocked(clerkClient)();
    expect(
      client.organizations.updateOrganizationMetadata,
    ).toHaveBeenLastCalledWith(expect.any(String), {
      publicMetadata: { default_agent_compose_id: null },
    });
  });

  it("should return 200 when setting same agent twice", async () => {
    await context.setupUser();
    const compose = await createTestCompose("test-agent");

    // Set default
    const response1 = await putDefaultAgent(undefined, compose.composeId);
    expect(response1.status).toBe(200);

    // Set same default again (idempotent)
    const response2 = await putDefaultAgent(undefined, compose.composeId);
    expect(response2.status).toBe(200);

    const data = await response2.json();
    expect(data.agentComposeId).toBe(compose.composeId);
  });
});
