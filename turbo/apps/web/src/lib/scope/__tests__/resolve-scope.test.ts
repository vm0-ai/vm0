import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { createTestScope } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { resolveScope, requireScopeFromRequest } from "../resolve-scope";

const context = testContext();

/**
 * Build clerkOrgs array for scopes created in a test.
 * Each scope created via createTestScope has clerkOrgId = "org_mock_{slug}".
 */
function scopeOrgs(...slugs: string[]) {
  return slugs.map((slug) => ({
    id: `org_mock_${slug}`,
    slug,
    name: slug,
  }));
}

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

    // Mock session with orgId pointing to scope2, include both scope orgs
    mockClerk({
      userId,
      orgId: `org_mock_${slug2}`,
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

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
    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: scopeOrgs(slug),
    });

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
    mockClerk({
      userId,
      orgId: "org_session_different",
      clerkOrgs: scopeOrgs(slug),
    });

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

    // Mock as CLI token — no orgId in session, but Clerk API returns user's orgs
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: scopeOrgs(slug),
    });

    // Resolve without slug — should fall through to getDefaultScope (Clerk API)
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
    mockClerk({
      userId,
      orgId: "org_nonexistent_xyz",
      clerkOrgs: scopeOrgs(slug),
    });

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
    mockClerk({
      userId,
      orgId: `org_mock_${slug2}`,
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

    // Resolve without slug — should return scope2 (from orgId), not scope1 (default)
    const result = await resolveScope(userId);

    expect(result.scope.id).toBe(scope2.id);
    expect(result.scope.slug).toBe(slug2);
    expect(result.scope.id).not.toBe(scope1.id);
  });

  it("reads tier from JWT sessionClaims when org matches", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    mockClerk({ userId });
    const created = await createTestScope(slug);

    // Mock session with orgTier in JWT claims
    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      orgTier: "pro",
      clerkOrgs: scopeOrgs(slug),
    });

    const result = await resolveScope(userId);

    expect(result.scope.id).toBe(created.id);
    // tier should be overridden from JWT
    expect(result.scope.tier).toBe("pro");
  });

  it("falls back to DB tier when JWT org_tier claim is missing", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    mockClerk({ userId });
    await createTestScope(slug);

    // Mock session WITHOUT orgTier
    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: scopeOrgs(slug),
    });

    const result = await resolveScope(userId);

    // tier should be DB default ("free")
    expect(result.scope.tier).toBe("free");
  });

  it("does not override tier when resolving non-active org via explicit slug", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");

    mockClerk({ userId });
    await createTestScope(slug1);
    await createTestScope(slug2);

    // JWT active org is scope2, but resolving scope1 via explicit slug
    mockClerk({
      userId,
      orgId: `org_mock_${slug2}`,
      orgTier: "max",
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

    const result = await resolveScope(userId, slug1);

    // tier should NOT be overridden (slug1 != active org)
    expect(result.scope.tier).toBe("free");
  });

  it("returns member with correct role", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    mockClerk({ userId });
    await createTestScope(slug);

    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: scopeOrgs(slug),
    });

    const result = await resolveScope(userId);

    expect(result.member.role).toBe("admin");
    expect(result.member.userId).toBe(userId);
    expect(result.member.scopeId).toBe(result.scope.id);
  });

  it("throws 403 when user is not a Clerk org member", async () => {
    const userId = uniqueId("test-user");
    const otherUserId = uniqueId("other-user");
    const slug = uniqueId("scope");

    mockClerk({ userId });
    await createTestScope(slug);

    // Mock as different user who is NOT in the org
    mockClerk({
      userId: otherUserId,
      orgId: null,
      clerkOrgs: [], // No orgs
    });

    await expect(resolveScope(otherUserId, slug)).rejects.toThrow(
      "You are not a member of this scope",
    );
  });

  it("?org= param resolves scope by clerkOrgId", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    mockClerk({ userId });
    const created = await createTestScope(slug);

    // Mock session — orgId is different from the explicit clerkOrgId
    mockClerk({
      userId,
      orgId: "org_session_different",
      clerkOrgs: scopeOrgs(slug),
    });

    // Pass clerkOrgId directly (simulates ?org= being passed as 3rd arg)
    const result = await resolveScope(userId, null, `org_mock_${slug}`);

    expect(result.scope.id).toBe(created.id);
    expect(result.scope.slug).toBe(slug);
  });

  it("?scope= takes priority over ?org=", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");

    mockClerk({ userId });
    const scope1 = await createTestScope(slug1);
    await createTestScope(slug2);

    mockClerk({
      userId,
      orgId: `org_mock_${slug1}`,
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

    // Pass both scopeSlug and clerkOrgId — scopeSlug should win
    const result = await resolveScope(userId, slug1, `org_mock_${slug2}`);

    expect(result.scope.id).toBe(scope1.id);
    expect(result.scope.slug).toBe(slug1);
  });
});

describe("requireScopeFromRequest", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("resolves scope via ?org= param", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    mockClerk({ userId });
    const created = await createTestScope(slug);

    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: scopeOrgs(slug),
    });

    const request = new Request(
      `http://localhost/api/test?org=org_mock_${slug}`,
    );
    const result = await requireScopeFromRequest(request, userId);

    expect(result.scope.id).toBe(created.id);
    expect(result.scope.slug).toBe(slug);
  });

  it("?scope= takes priority over ?org=", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");

    mockClerk({ userId });
    const scope1 = await createTestScope(slug1);
    await createTestScope(slug2);

    mockClerk({
      userId,
      orgId: `org_mock_${slug1}`,
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

    // Both ?scope= and ?org= provided — ?scope= should win
    const request = new Request(
      `http://localhost/api/test?scope=${slug1}&org=org_mock_${slug2}`,
    );
    const result = await requireScopeFromRequest(request, userId);

    expect(result.scope.id).toBe(scope1.id);
  });

  it("throws 400 when neither ?scope= nor ?org= provided", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const request = new Request("http://localhost/api/test");

    await expect(requireScopeFromRequest(request, userId)).rejects.toThrow(
      "scope or org query parameter is required",
    );
  });

  it("throws 404 for non-existent ?org= value", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const request = new Request(
      "http://localhost/api/test?org=org_nonexistent",
    );

    await expect(requireScopeFromRequest(request, userId)).rejects.toThrow(
      "Scope not found",
    );
  });
});
