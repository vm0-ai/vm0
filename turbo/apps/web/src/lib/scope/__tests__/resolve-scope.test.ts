import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { createTestScope } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { resolveScope, requireScopeFromRequest } from "../resolve-scope";

const context = testContext();

/**
 * Build clerkOrgs array for scopes created in a test.
 * Must be used BEFORE calling createTestScope() so the POST route
 * resolves the correct orgId from the user's org memberships.
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

    // Create two additional scopes — set up Clerk orgs BEFORE creating scopes
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");
    mockClerk({
      userId,
      clerkOrgs: [
        // Include the org from setupUser so it's already matched
        {
          id: `org_mock_${userId}`,
          slug: `org-${userId}`,
          name: `org-${userId}`,
        },
        ...scopeOrgs(slug1, slug2),
      ],
    });
    const scope1 = await createTestScope(slug1);
    const scope2 = await createTestScope(slug2);

    // Mock session with orgId pointing to scope2
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

    // Set up Clerk org BEFORE creating scope so POST resolves correct orgId
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
    const created = await createTestScope(slug);

    // Mock session with orgId matching the scope's orgId
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

  it("tier 2: explicit orgId parameter takes precedence over session", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
    const created = await createTestScope(slug);

    // Mock session with a different orgId (should NOT be used)
    mockClerk({
      userId,
      orgId: "org_session_different",
      clerkOrgs: scopeOrgs(slug),
    });

    // Pass explicit orgId matching the scope
    const result = await resolveScope(userId, null, `org_mock_${slug}`);

    expect(result.scope.id).toBe(created.id);
    expect(result.scope.slug).toBe(slug);
  });

  it("tier 3: falls through when no Clerk session (CLI token)", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

    // Set up two Clerk orgs BEFORE creating scopes
    mockClerk({
      userId,
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

    // Create first scope (will be the default — earliest createdAt)
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

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

    // Set up two Clerk orgs BEFORE creating scopes
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug1, slug2) });
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

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

  it("?org= param resolves scope by orgId", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("scope");

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
    const created = await createTestScope(slug);

    // Mock session — orgId is different from the explicit orgId
    mockClerk({
      userId,
      orgId: "org_session_different",
      clerkOrgs: scopeOrgs(slug),
    });

    // Pass orgId directly (simulates ?org= being passed as 3rd arg)
    const result = await resolveScope(userId, null, `org_mock_${slug}`);

    expect(result.scope.id).toBe(created.id);
    expect(result.scope.slug).toBe(slug);
  });

  it("?scope= takes priority over ?org=", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("scope");
    const slug2 = uniqueId("scope");

    // Set up two Clerk orgs BEFORE creating scopes
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug1, slug2) });
    const scope1 = await createTestScope(slug1);
    await createTestScope(slug2);

    mockClerk({
      userId,
      orgId: `org_mock_${slug1}`,
      clerkOrgs: scopeOrgs(slug1, slug2),
    });

    // Pass both scopeSlug and orgId — scopeSlug should win
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

    // Set up Clerk org BEFORE creating scope
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug) });
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

    // Set up two Clerk orgs BEFORE creating scopes
    mockClerk({ userId, clerkOrgs: scopeOrgs(slug1, slug2) });
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
