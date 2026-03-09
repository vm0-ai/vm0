import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestRequest,
  getTestScope,
} from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import { PUT } from "../route";

const context = testContext();

describe("PUT /api/admin/scope/tier", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  function callSetTier(body: { slug: string; tier: string }) {
    const request = createTestRequest(
      "http://localhost:3000/api/admin/scope/tier",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return PUT(request);
  }

  function setupAdmin(userId: string) {
    mockClerk({ userId, email: "admin@vm0.ai" });
    vi.stubEnv("VM0_ADMIN_USERS", "admin@vm0.ai");
    reloadEnv();
  }

  it("should set scope tier when called by admin", async () => {
    const user = await context.setupUser();
    setupAdmin(user.userId);

    const scope = await getTestScope(user.scopeId);

    const response = await callSetTier({
      slug: scope.slug,
      tier: "pro",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.slug).toBe(scope.slug);
    expect(body.tier).toBe("pro");
    expect(body.updatedAt).toBeDefined();
  });

  it("should set scope tier to max when called by admin", async () => {
    const user = await context.setupUser();
    setupAdmin(user.userId);

    const scope = await getTestScope(user.scopeId);

    const response = await callSetTier({
      slug: scope.slug,
      tier: "max",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.slug).toBe(scope.slug);
    expect(body.tier).toBe("max");
    expect(body.updatedAt).toBeDefined();
  });

  it("should reject non-admin users with 403", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, email: "user@example.com" });
    vi.stubEnv("VM0_ADMIN_USERS", "admin@vm0.ai");
    reloadEnv();

    const response = await callSetTier({
      slug: "any-scope",
      tier: "pro",
    });

    expect(response.status).toBe(403);
  });

  it("should return 404 for non-existent scope", async () => {
    const user = await context.setupUser();
    setupAdmin(user.userId);

    const response = await callSetTier({
      slug: uniqueId("nonexistent"),
      tier: "pro",
    });

    expect(response.status).toBe(404);
  });

  it("should reject invalid tier with 400", async () => {
    const user = await context.setupUser();
    setupAdmin(user.userId);

    const response = await callSetTier({
      slug: "any-scope",
      tier: "enterprise",
    });

    expect(response.status).toBe(400);
  });

  it("should return 401 for unauthenticated request", async () => {
    mockClerk({ userId: null });

    const response = await callSetTier({
      slug: "any-scope",
      tier: "pro",
    });

    expect(response.status).toBe(401);
  });
});
