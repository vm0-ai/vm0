import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestModelProvider,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { PUT as setDefaultAgent } from "../../../../api/scopes/default-agent/route";

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

  it("should return needsOnboarding=true when user has no scope", async () => {
    const userId = `no-scope-user-${Date.now()}`;
    mockClerk({ userId });

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: true,
      hasScope: false,
      hasModelProvider: false,
      hasDefaultAgent: false,
      defaultAgentName: null,
      defaultAgentComposeId: null,
      defaultAgentMetadata: null,
    });
  });

  it("should return hasScope=true, hasModelProvider=false when scope exists but no provider", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasScope).toBe(true);
    expect(data.hasModelProvider).toBe(false);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return hasModelProvider=true, hasDefaultAgent=false when provider exists but no default agent", async () => {
    await context.setupUser();
    await createTestModelProvider("anthropic-api-key", "test-secret-key");

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasScope).toBe(true);
    expect(data.hasModelProvider).toBe(true);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return needsOnboarding=false when all conditions met", async () => {
    await context.setupUser();
    await createTestModelProvider("anthropic-api-key", "test-secret-key");

    // Create a compose and set as default via API
    const compose = await createTestCompose("test-agent");

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/scopes/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentComposeId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: false,
      hasScope: true,
      hasModelProvider: true,
      hasDefaultAgent: true,
      defaultAgentName: "test-agent",
      defaultAgentComposeId: compose.composeId,
      defaultAgentMetadata: null,
    });
  });

  it("should return defaultAgentMetadata when compose has metadata", async () => {
    await context.setupUser();
    await createTestModelProvider("anthropic-api-key", "test-secret-key");

    // Create a compose with metadata
    const compose = await createTestCompose("test-agent", {
      metadata: { displayName: "My Agent", sound: "friendly" },
    });

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/scopes/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentComposeId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    const request = createTestRequest(
      "http://localhost:3000/api/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: false,
      hasScope: true,
      hasModelProvider: true,
      hasDefaultAgent: true,
      defaultAgentName: "test-agent",
      defaultAgentComposeId: compose.composeId,
      defaultAgentMetadata: { displayName: "My Agent", sound: "friendly" },
    });
  });
});
