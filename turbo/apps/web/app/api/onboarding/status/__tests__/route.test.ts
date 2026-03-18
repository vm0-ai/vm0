import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import { upsertOrgModelProvider } from "../../../../../src/lib/model-provider/model-provider-service";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { PUT as setDefaultAgent } from "../../../../api/orgs/default-agent/route";
import { POST as completeOnboarding } from "../../complete/route";

const context = testContext();

describe("GET /api/onboarding/status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return needsOnboarding=true when user has no org", async () => {
    const userId = `no-org-user-${Date.now()}`;
    // Use a non-existent orgId so resolveOrg throws NotFoundError (caught by route)
    // rather than BadRequestError (which would propagate as 500)
    mockClerk({ userId, clerkOrgs: [], orgId: "org_nonexistent" });

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: true,
      isAdmin: false,
      hasOrg: false,
      hasModelProvider: false,
      hasDefaultAgent: false,
      defaultAgentName: null,
      defaultAgentComposeId: null,
      defaultAgentMetadata: null,
      defaultAgentSkills: [],
    });
  });

  it("should return hasOrg=true, hasModelProvider=false when org exists but no provider", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasOrg).toBe(true);
    expect(data.hasModelProvider).toBe(false);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return hasModelProvider=true, hasDefaultAgent=false when provider exists but no default agent", async () => {
    const user = await context.setupUser();
    await upsertOrgModelProvider(
      user.orgId,
      "anthropic-api-key",
      "test-secret-key",
    );

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasOrg).toBe(true);
    expect(data.hasModelProvider).toBe(true);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return hasModelProvider=true when org-level provider exists", async () => {
    const user = await context.setupUser();

    // Create org-level model provider
    await upsertOrgModelProvider(
      user.orgId,
      "anthropic-api-key",
      "test-org-secret-key",
    );

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasOrg).toBe(true);
    expect(data.hasModelProvider).toBe(true);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return needsOnboarding=false when all conditions met", async () => {
    const user = await context.setupUser();
    await upsertOrgModelProvider(
      user.orgId,
      "anthropic-api-key",
      "test-secret-key",
    );

    // Create a compose and set as default via API
    const compose = await createTestCompose("test-agent");

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/orgs/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentComposeId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    // Re-mock Clerk so the JWT session claim includes the compose ID
    // (in production, Clerk propagates org metadata to JWT claims)
    mockClerk({
      userId: user.userId,
      orgDefaultAgentComposeId: compose.composeId,
    });

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasModelProvider: true,
      hasDefaultAgent: true,
      defaultAgentName: "test-agent",
      defaultAgentComposeId: compose.composeId,
      defaultAgentMetadata: null,
      defaultAgentSkills: [],
    });
  });

  it("should return defaultAgentMetadata when compose has metadata", async () => {
    const user = await context.setupUser();
    await upsertOrgModelProvider(
      user.orgId,
      "anthropic-api-key",
      "test-secret-key",
    );

    // Create a compose with metadata
    const compose = await createTestCompose("test-agent", {
      metadata: { displayName: "My Agent", sound: "friendly" },
    });

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/orgs/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentComposeId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    // Re-mock Clerk so the JWT session claim includes the compose ID
    mockClerk({
      userId: user.userId,
      orgDefaultAgentComposeId: compose.composeId,
    });

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasModelProvider: true,
      hasDefaultAgent: true,
      defaultAgentName: "test-agent",
      defaultAgentComposeId: compose.composeId,
      defaultAgentMetadata: { displayName: "My Agent", sound: "friendly" },
      defaultAgentSkills: [],
    });
  });

  it("should return needsOnboarding=true for non-admin member who has not completed onboarding", async () => {
    const user = await context.setupUser();

    // Switch to member role — the member path checks org_members_cache / Clerk metadata
    mockClerk({
      userId: user.userId,
      orgRole: "org:member",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:member",
        },
      ],
    });

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.isAdmin).toBe(false);
    expect(data.hasOrg).toBe(true);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return needsOnboarding=false for non-admin member after completing onboarding", async () => {
    const user = await context.setupUser();

    // Switch to member role
    mockClerk({
      userId: user.userId,
      orgRole: "org:member",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:member",
        },
      ],
    });

    // Complete onboarding via POST /api/onboarding/complete
    const completeRequest = createTestRequest(
      "http://localhost:3000/api/onboarding/complete",
      { method: "POST" },
    );
    const completeResponse = await completeOnboarding(completeRequest);
    expect(completeResponse.status).toBe(200);

    // Status should now show needsOnboarding=false
    const statusRequest = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const statusResponse = await GET(statusRequest);
    const statusData = await statusResponse.json();

    expect(statusResponse.status).toBe(200);
    expect(statusData.isAdmin).toBe(false);
    expect(statusData.hasOrg).toBe(true);
    expect(statusData.needsOnboarding).toBe(false);
  });
});
