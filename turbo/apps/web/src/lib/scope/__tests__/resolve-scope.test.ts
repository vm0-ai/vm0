import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { createTestScope } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { resolveScope } from "../resolve-scope";

const context = testContext();

describe("resolveScope", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("tier 1: scopeSlug takes priority over orgId from session", async () => {
    const { userId } = await context.setupUser();

    // Create two scopes for the same user
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");
    mockClerk({ userId });
    const scope1 = await createTestScope(slug1);
    const scope2 = await createTestScope(slug2);

    // Mock session with orgId pointing to scope2
    mockClerk({ userId, orgId: `org_mock_${slug2}` });

    // Resolve with explicit slug for scope1 — should return scope1, not scope2
    const result = await resolveScope(userId, slug1);

    expect(result.scope.id).toBe(scope1.id);
    expect(result.scope.id).not.toBe(scope2.id);
  });

  it("tier 2: auto-detects orgId from Clerk session", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Create scope (clerkOrgId = "org_mock_{slug}" via Clerk mock)
    mockClerk({ userId });
    const created = await createTestScope(slug);

    // Mock session with orgId matching the scope's clerkOrgId
    mockClerk({ userId, orgId: `org_mock_${slug}` });

    // Resolve without slug or explicit orgId — should auto-detect from session
    const result = await resolveScope(userId);

    expect(result.scope.id).toBe(created.id);
    expect(result.scope.slug).toBe(slug);
  });

  it("tier 2: explicit clerkOrgId parameter takes precedence over session", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Create scope
    mockClerk({ userId });
    const created = await createTestScope(slug);

    // Mock session with a different orgId (should NOT be used)
    mockClerk({ userId, orgId: "org_session_different" });

    // Pass explicit clerkOrgId matching the scope
    const result = await resolveScope(userId, null, `org_mock_${slug}`);

    expect(result.scope.id).toBe(created.id);
    expect(result.scope.slug).toBe(slug);
  });

  it("tier 3: falls through when no Clerk session (CLI token)", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Create scope (user's default scope)
    mockClerk({ userId });
    const created = await createTestScope(slug);

    // Mock as CLI token — no orgId in session
    mockClerk({ userId, orgId: null });

    // Resolve without slug — should fall through to getDefaultScope
    const result = await resolveScope(userId);

    expect(result.scope.id).toBe(created.id);
  });

  it("tier 3: falls through when orgId has no matching scope", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Create scope (user's default scope)
    mockClerk({ userId });
    const created = await createTestScope(slug);

    // Mock session with an orgId that doesn't match any scope
    mockClerk({ userId, orgId: "org_nonexistent_xyz" });

    // Resolve without slug — orgId lookup returns null, falls to default
    const result = await resolveScope(userId);

    expect(result.scope.id).toBe(created.id);
  });

  it("tier 2: resolves correct scope when user has multiple scopes", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");

    // Create first scope (will be the default — earliest createdAt)
    mockClerk({ userId });
    const scope1 = await createTestScope(slug1);

    // Create second scope
    const scope2 = await createTestScope(slug2);

    // Mock session with orgId matching the SECOND scope
    mockClerk({ userId, orgId: `org_mock_${slug2}` });

    // Resolve without slug — should return scope2 (from orgId), not scope1 (default)
    const result = await resolveScope(userId);

    expect(result.scope.id).toBe(scope2.id);
    expect(result.scope.slug).toBe(slug2);
    expect(result.scope.id).not.toBe(scope1.id);
  });
});
