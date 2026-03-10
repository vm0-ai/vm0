import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestModelProvider,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";

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
    initServices();
    const user = await context.setupUser();
    await createTestModelProvider("anthropic-api-key", "test-secret-key");

    // Create a compose and set as default
    const compose = await createTestCompose("test-agent");

    await globalThis.services.db
      .update(scopes)
      .set({ defaultAgentComposeId: compose.composeId })
      .where(eq(scopes.id, user.scopeId));

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
    });
  });
});
