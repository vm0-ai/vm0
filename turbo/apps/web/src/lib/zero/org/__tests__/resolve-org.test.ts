import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestOrg,
  updateOrgTier,
  ensureOrgRow,
} from "../../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import { resolveOrg } from "../resolve-org";
import type { AuthContext } from "../../../auth/get-auth-context";

const context = testContext();

/**
 * Build clerkOrgs array for orgs created in a test.
 * Must be used BEFORE calling createTestOrg() so the POST route
 * resolves the correct orgId from the user's org memberships.
 */
function testOrgs(...slugs: string[]) {
  return slugs.map((slug) => {
    return {
      id: `org_mock_${slug}`,
      slug,
      name: slug,
    };
  });
}

/**
 * Build an AuthContext matching what getAuthContext() would return
 * for a Clerk session with the given mockClerk configuration.
 */
function authCtx(opts: {
  userId: string;
  orgId?: string | null;
  orgRole?: "admin" | "member";
  sessionClaims?: Record<string, unknown>;
}): AuthContext {
  return {
    userId: opts.userId,
    orgId: opts.orgId ?? undefined,
    orgRole: opts.orgId ? (opts.orgRole ?? "admin") : undefined,
    sessionClaims: opts.sessionClaims,
  };
}

describe("resolveOrg", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("auto-detects orgId from AuthContext", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org so POST resolves correct orgId
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    const { id: orgId } = await createTestOrg(slug);

    // Mock Clerk for membership verification
    mockClerk({
      userId,
      orgId,
      clerkOrgs: testOrgs(slug),
    });

    // Resolve without slug or explicit orgId — should auto-detect from AuthContext
    const result = await resolveOrg(authCtx({ userId, orgId }));

    expect(result.org.orgId).toBe(orgId);
  });

  it("throws 400 when no explicit org context available", async () => {
    const userId = uniqueId("test-user");

    // Mock as CLI token — no orgId in session
    mockClerk({
      userId,
      orgId: null,
      clerkOrgs: [],
    });

    // Resolve without slug, orgId, or AuthContext orgId — should throw
    await expect(resolveOrg(authCtx({ userId }))).rejects.toThrow(
      "Explicit org context required",
    );
  });

  it("resolves correct org when user has multiple orgs", async () => {
    const userId = uniqueId("test-user");
    const slug1 = uniqueId("org");
    const slug2 = uniqueId("org");

    // Set up two Clerk orgs BEFORE creating orgs
    mockClerk({
      userId,
      clerkOrgs: testOrgs(slug1, slug2),
    });

    // Create first org
    const { id: orgId1 } = await createTestOrg(slug1);

    // Create second org manually (createTestOrg reuses the same orgId per userId)
    const orgId2 = `org_mock_${slug2}`;
    await ensureOrgRow(orgId2);

    // Mock session with orgId matching the SECOND org
    mockClerk({
      userId,
      orgId: orgId2,
      clerkOrgs: [
        { id: orgId1, slug: slug1, name: slug1 },
        { id: orgId2, slug: slug2, name: slug2 },
      ],
    });

    // Resolve without explicit orgId — should return org2 (from AuthContext orgId)
    const result = await resolveOrg(authCtx({ userId, orgId: orgId2 }));

    expect(result.org.orgId).toBe(orgId2);
    expect(result.org.orgId).not.toBe(orgId1);
  });

  it("reads tier from org table", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    const { id: orgId } = await createTestOrg(slug);

    // Update tier in org table (use orgId from createTestOrg, not from slug)
    await updateOrgTier(orgId, "pro");

    // Mock Clerk for membership verification
    mockClerk({
      userId,
      orgId,
      clerkOrgs: testOrgs(slug),
    });

    const result = await resolveOrg(authCtx({ userId, orgId }));

    expect(result.org.orgId).toBe(orgId);
    expect(result.org.tier).toBe("pro");
  });

  it("returns default tier when org table has default", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    const { id: orgId } = await createTestOrg(slug);

    // Mock session WITHOUT setting tier in org table (default is "free")
    mockClerk({
      userId,
      orgId,
      clerkOrgs: testOrgs(slug),
    });

    const result = await resolveOrg(authCtx({ userId, orgId }));

    // tier should be DB default ("free")
    expect(result.org.tier).toBe("free");
  });

  it("tier reflects org table value, not a default", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    const { id: orgId } = await createTestOrg(slug);

    // Verify default tier is "free"
    mockClerk({ userId, orgId, clerkOrgs: testOrgs(slug) });
    const result1 = await resolveOrg(authCtx({ userId, orgId }));
    expect(result1.org.tier).toBe("free");

    // Update tier to "team"
    await updateOrgTier(orgId, "team");

    const result2 = await resolveOrg(authCtx({ userId, orgId }));
    expect(result2.org.tier).toBe("team");
  });

  it("returns free tier defaults for brand-new org without org_metadata row", async () => {
    const userId = uniqueId("test-user");
    const orgId = uniqueId("brand-new-org");

    const result = await resolveOrg(authCtx({ userId, orgId }));

    expect(result.org.orgId).toBe(orgId);
    expect(result.org.tier).toBe("free");
  });

  it("returns member with correct role", async () => {
    const userId = uniqueId("test-user");
    const slug = uniqueId("org");

    // Set up Clerk org BEFORE creating org
    mockClerk({ userId, clerkOrgs: testOrgs(slug) });
    const { id: orgId } = await createTestOrg(slug);

    mockClerk({
      userId,
      orgId,
      clerkOrgs: testOrgs(slug),
    });

    const result = await resolveOrg(authCtx({ userId, orgId }));

    expect(result.member.role).toBe("admin");
    expect(result.member.userId).toBe(userId);
  });
});
