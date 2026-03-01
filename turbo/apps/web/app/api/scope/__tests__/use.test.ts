import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as createOrgRoute } from "../../org/route";
import { GET as listScopesRoute } from "../../scope/list/route";
import { POST } from "../../scope/use/route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { setupClerkOrgMock } from "../../../../src/__tests__/org-test-helpers";
import { reloadEnv } from "../../../../src/env";

const context = testContext();

describe("POST /api/scope/use - Scope Use", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "some-slug" }),
    });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should switch to org scope and return org token", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("org");
    const orgId = `org_${user.userId}`;
    setupClerkOrgMock({
      userId: user.userId,
      orgId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    // Create org first
    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);

    // Use org scope
    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const useRes = await POST(useReq);
    expect(useRes.status).toBe(200);

    const data = await useRes.json();
    expect(data.scope.slug).toBe(slug);
    expect(data.token).toBeTruthy();
    expect(data.token).toMatch(/^vm0_org_/);
    expect(data.expiresAt).toBeTruthy();
  });

  it("should switch to personal scope", async () => {
    const user = await context.setupUser();
    setupClerkOrgMock({ userId: user.userId });

    // List scopes to find personal scope slug
    const listReq = createTestRequest("http://localhost:3000/api/scope/list");
    const listRes = await listScopesRoute(listReq);
    const listData = await listRes.json();

    const personal = listData.scopes.find(
      (s: { type: string }) => s.type === "personal",
    );
    expect(personal).toBeDefined();

    // Switch to personal scope
    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: personal.slug }),
    });
    const useRes = await POST(useReq);
    expect(useRes.status).toBe(200);

    const data = await useRes.json();
    expect(data.scope.type).toBe("personal");
    expect(data.token).toBe("");
    expect(data.expiresAt).toBe("");
  });

  it("should reject non-existent scope", async () => {
    await context.setupUser();

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "nonexistent-scope-slug" }),
    });
    const useRes = await POST(useReq);
    expect(useRes.status).toBe(404);
  });
});

describe("POST /api/scope/use - VM0 Admin System Scope", () => {
  const ADMIN_EMAIL = "admin@vm0.ai";

  beforeEach(() => {
    context.setupMocks();
  });

  it("should allow admin to activate vm0 system scope", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, email: ADMIN_EMAIL });

    vi.stubEnv("VM0_ADMIN_USERS", ADMIN_EMAIL);
    reloadEnv();

    // vm0 system scope exists from migration seed
    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "vm0" }),
    });
    const useRes = await POST(useReq);
    expect(useRes.status).toBe(200);

    const data = await useRes.json();
    expect(data.scope.slug).toBe("vm0");
    expect(data.scope.type).toBe("system");
    expect(data.token).toMatch(/^vm0_org_/);
    expect(data.expiresAt).toBeTruthy();
  });

  it("should reject non-admin from activating vm0 system scope", async () => {
    const user = await context.setupUser();
    // Default mockClerk email is "test@example.com" which is not an admin
    mockClerk({ userId: user.userId });

    vi.stubEnv("VM0_ADMIN_USERS", "other-admin@vm0.ai");
    reloadEnv();

    const useReq = createTestRequest("http://localhost:3000/api/scope/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "vm0" }),
    });
    const useRes = await POST(useReq);
    expect(useRes.status).toBe(403);
  });
});

describe("POST /api/org - VM0 Admin Org Creation", () => {
  const ADMIN_EMAIL = "admin@vm0.ai";

  beforeEach(() => {
    context.setupMocks();
  });

  it("should allow admin to create vm0-prefixed org", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("vm0-team");
    setupClerkOrgMock({
      userId: user.userId,
      email: ADMIN_EMAIL,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    vi.stubEnv("VM0_ADMIN_USERS", ADMIN_EMAIL);
    reloadEnv();

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(201);
  });

  it("should reject non-admin from creating vm0-prefixed org", async () => {
    const user = await context.setupUser();
    const slug = uniqueId("vm0-team");
    setupClerkOrgMock({
      userId: user.userId,
      memberships: [{ userId: user.userId, role: "org:admin" }],
    });

    vi.stubEnv("VM0_ADMIN_USERS", "other-admin@vm0.ai");
    reloadEnv();

    const createReq = createTestRequest("http://localhost:3000/api/org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const createRes = await createOrgRoute(createReq);
    expect(createRes.status).toBe(400);
  });
});
