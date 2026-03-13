import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import {
  createTestOrg,
  insertOrgCacheEntry,
  insertOrgMembersCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { resolveOrg, requireOrgFromRequest } from "../resolve-org";

const context = testContext();

/**
 * Build clerkOrgs array for orgs created in a test.
 * Must be used BEFORE calling createTestOrg() so the POST route
 * resolves the correct orgId from the user's org memberships.
 */
function testOrgs(...slugs: string[]) {
  return slugs.map((slug) => ({
    id: `org_mock_${slug}`,
    slug,
    name: slug,
  }));
}

describe("resolveOrg", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("tier 1: orgSlug takes priority over orgId from session", async () => {
    const { userId } = await context.setupUser();

    // Create two additional orgs — set up Clerk orgs BEFORE creating orgs
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");
    mockClerk({
      userId,
      clerkOrgs: [
        // Include the org from setupUser so it's already matched
        {
          id: `org_mock_${userId}`,
          slug: `org-${userId}`,
          name: `org-${userId}`,
        },
        ...testOrgs(slug1, slug2),
      ],
    });
    await createTestOrg(slug1);
    await createTestOrg(slug2);

    // Mock session with orgId pointing to org2
    mockClerk({
      userId,
      orgId: `org_mock_${slug2}`,
      clerkOrgs: testOrgs(slug1, slug2),
    });

    // Resolve with explicit slug for org1 — should return org1, not org2
    const result = await resolveOrg(userId, slug1);

    expect(result.org.orgId).toBe(`org_mock_${slug1}`);
    expect(result.org.orgId).not.toBe(`org_mock_${slug2}`);
  });

  it("tier 2: auto-detects orgId from Clerk session", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org so POST resolves correct orgId
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock session with orgId matching the org's orgId
    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: testOrgs(slug),
    });

    // Resolve without slug or explicit orgId — should auto-detect from session
    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
    expect(result.org.slug).toBe(slug);
  });

  it("tier 2: explicit orgId parameter takes precedence over session", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock session with a different orgId (should NOT be used)
    mockClerk({
      userId,
      orgId: "org_session_different",
      clerkOrgs: testOrgs(slug),
    });

    // Pass explicit orgId matching the org
    const result = await resolveOrg(userId, null, `org_mock_${slug}`);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
    expect(result.org.slug).toBe(slug);
  });

  it("tier 3: falls through when no Clerk session (CLI token)", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock as CLI token — no orgId in session, but Clerk API returns user's orgs
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: testOrgs(slug),
    });

    // Resolve without slug — should fall through to default org (Clerk API)
    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
  });

  it("tier 3: resolves via org_members_cache when no Clerk session", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;

    // Pre-populate org_cache so getOrgDataOrNull resolves
    await insertOrgCacheEntry({ orgId, slug });

    // Pre-populate org_members_cache with a fresh entry (< 1 min TTL)
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });

    // Mock as CLI token — no orgId, no Clerk orgs (tier 4 would fail)
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [],
    });

    // Resolve without slug — tier 2 skipped (no orgId), tier 3 should hit cache
    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(orgId);
    expect(result.org.slug).toBe(slug);
  });

  it("tier 3: skips stale org_members_cache entries (>1 min TTL)", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");
    const orgId = `org_mock_${slug}`;
    const freshSlug = uniqueId("org");
    const freshOrgId = `org_mock_${freshSlug}`;

    // Pre-populate org_cache for the cached org
    await insertOrgCacheEntry({ orgId, slug });

    // Pre-populate org_members_cache with a STALE entry (> 1 min ago)
    const staleTime = new Date(Date.now() - 120_000);
    await insertOrgMembersCacheEntry({
      orgId,
      userId,
      role: "admin",
      cachedAt: staleTime,
    });

    // Set up a fresh org via Clerk API (tier 4 fallback)
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [{ id: freshOrgId, slug: freshSlug, name: freshSlug }],
    });
    await createTestOrg(freshSlug);

    // Re-mock without orgId for the actual resolution call
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [{ id: freshOrgId, slug: freshSlug, name: freshSlug }],
    });

    // Stale cache should be skipped, falls through to tier 4 (Clerk API)
    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(freshOrgId);
    expect(result.org.slug).toBe(freshSlug);
  });

  it("tier 3: falls through when orgId has no matching org", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock session with an orgId that doesn't match any org
    mockClerk({
      userId,
      orgId: "org_nonexistent_xyz",
      clerkOrgs: testOrgs(slug),
    });

    // Resolve without slug — orgId lookup returns null, falls to default
    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
  });

  it("tier 2: resolves correct org when user has multiple orgs", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");

    // Set up two Clerk orgs BEFORE creating orgs
    mockClerk({
      userId,
      clerkOrgs: testOrgs(slug1, slug2),
    });

    // Create first org (will be the default — earliest createdAt)
    await createTestOrg(slug1);

    // Create second org
    await createTestOrg(slug2);

    // Mock session with orgId matching the SECOND org
    mockClerk({
      userId,
      orgId: `org_mock_${slug2}`,
      clerkOrgs: testOrgs(slug1, slug2),
    });

    // Resolve without slug — should return org2 (from orgId), not org1 (default)
    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(`org_mock_${slug2}`);
    expect(result.org.slug).toBe(slug2);
    expect(result.org.orgId).not.toBe(`org_mock_${slug1}`);
  });

  it("reads tier from JWT sessionClaims when org matches", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock session with orgTier in JWT claims
    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      orgTier: "pro",
      clerkOrgs: testOrgs(slug),
    });

    const result = await resolveOrg(userId);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
    // tier should be overridden from JWT
    expect(result.org.tier).toBe("pro");
  });

  it("falls back to DB tier when JWT org_tier claim is missing", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock session WITHOUT orgTier
    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: testOrgs(slug),
    });

    const result = await resolveOrg(userId);

    // tier should be DB default ("free")
    expect(result.org.tier).toBe("free");
  });

  it("does not override tier when resolving non-active org via explicit slug", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");

    // Set up two Clerk orgs BEFORE creating orgs
    mockClerk({ userId, clerkOrgs: testOrgs(slug1, slug2) });
    await createTestOrg(slug1);
    await createTestOrg(slug2);

    // JWT active org is org2, but resolving org1 via explicit slug
    mockClerk({
      userId,
      orgId: `org_mock_${slug2}`,
      orgTier: "max",
      clerkOrgs: testOrgs(slug1, slug2),
    });

    const result = await resolveOrg(userId, slug1);

    // tier should NOT be overridden (slug1 != active org)
    expect(result.org.tier).toBe("free");
  });

  it("returns member with correct role", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: testOrgs(slug),
    });

    const result = await resolveOrg(userId);

    expect(result.member.role).toBe("admin");
    expect(result.member.userId).toBe(userId);
  });

  it("throws 403 when user is not a Clerk org member", async () => {
    const userId = uniqueId("test-user");
    const otherUserId = uniqueId("other-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock as different user who is NOT in the org
    mockClerk({
      userId: otherUserId,
      orgId: null,
      clerkOrgs: [], // No orgs
    });

    await expect(resolveOrg(otherUserId, slug)).rejects.toThrow(
      "You are not a member of this organization",
    );
  });

  it("?org= param resolves org by orgId", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    // Mock session — orgId is different from the explicit orgId
    mockClerk({
      userId,
      orgId: "org_session_different",
      clerkOrgs: testOrgs(slug),
    });

    // Pass orgId directly (simulates ?org= being passed as 3rd arg)
    const result = await resolveOrg(userId, null, `org_mock_${slug}`);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
    expect(result.org.slug).toBe(slug);
  });

  it("orgSlug takes priority over orgId", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");

    // Set up two Clerk orgs BEFORE creating orgs
    mockClerk({ userId, clerkOrgs: testOrgs(slug1, slug2) });
    await createTestOrg(slug1);
    await createTestOrg(slug2);

    mockClerk({
      userId,
      orgId: `org_mock_${slug1}`,
      clerkOrgs: testOrgs(slug1, slug2),
    });

    // Pass both orgSlug and orgId — orgSlug should win
    const result = await resolveOrg(userId, slug1, `org_mock_${slug2}`);

    expect(result.org.orgId).toBe(`org_mock_${slug1}`);
    expect(result.org.slug).toBe(slug1);
  });
});

describe("requireOrgFromRequest", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("resolves org via ?org= param", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    await createTestOrg(slug);

    mockClerk({
      userId,
      orgId: `org_mock_${slug}`,
      clerkOrgs: testOrgs(slug),
    });

    const request = new Request(
      `http://localhost/api/test?org=org_mock_${slug}`,
    );
    const result = await requireOrgFromRequest(request, userId);

    expect(result.org.orgId).toBe(`org_mock_${slug}`);
    expect(result.org.slug).toBe(slug);
  });

  it("resolves org via ?org= slug param", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");

    // createTestOrg derives orgId from auth().userId → org_mock_${userId}
    const expectedOrgId = `org_mock_${userId}`;

    // Set up Clerk org BEFORE creating org — use matching orgId
    mockClerk({
      userId,
      clerkOrgs: [{ id: expectedOrgId, slug: slug1, name: slug1 }],
    });
    await createTestOrg(slug1);

    mockClerk({
      userId,
      orgId: expectedOrgId,
      clerkOrgs: [{ id: expectedOrgId, slug: slug1, name: slug1 }],
    });

    const request = new Request(`http://localhost/api/test?org=${slug1}`);
    const result = await requireOrgFromRequest(request, userId);

    expect(result.org.orgId).toBe(expectedOrgId);
  });

  it("throws 400 when ?org= not provided", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const request = new Request("http://localhost/api/test");

    await expect(requireOrgFromRequest(request, userId)).rejects.toThrow(
      "org query parameter is required",
    );
  });

  it("throws 404 for non-existent ?org= value", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });

    const request = new Request(
      "http://localhost/api/test?org=org_nonexistent",
    );

    await expect(requireOrgFromRequest(request, userId)).rejects.toThrow(
      "Org not found",
    );
  });
});
