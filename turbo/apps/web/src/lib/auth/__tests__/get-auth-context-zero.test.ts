import { describe, it, expect, beforeEach, vi } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { getAuthContext } from "../get-auth-context";
import { generateZeroToken } from "../sandbox-token";
import { clearOrgMembersCacheEntry } from "../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { testContext, type UserContext } from "../../../__tests__/test-helpers";

const context = testContext();

describe("getAuthContext with zero token orgRole", () => {
  const mockAuth = vi.mocked(auth);
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should resolve orgRole as admin for zero token with admin user", async () => {
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    // Mock Clerk to return admin role
    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:admin",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:admin",
        },
      ],
    });
    await clearOrgMembersCacheEntry(user.orgId, user.userId);

    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.userId);
    expect(result?.orgId).toBe(user.orgId);
    expect(result?.orgRole).toBe("admin");
  });

  it("should resolve orgRole as member for zero token with member user", async () => {
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
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
    await clearOrgMembersCacheEntry(user.orgId, user.userId);

    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.userId);
    expect(result?.orgId).toBe(user.orgId);
    expect(result?.orgRole).toBe("member");
  });

  it("should omit orgId when user is no longer an org member", async () => {
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    // Mock Clerk to return no memberships (user was removed from org)
    mockClerk({ userId: user.userId, clerkOrgs: [] });
    await clearOrgMembersCacheEntry(user.orgId, user.userId);

    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.userId);
    expect(result?.orgId).toBeUndefined();
    expect(result?.orgRole).toBeUndefined();
  });

  it("should resolve orgRole with acceptAnySandboxCapability", async () => {
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    mockClerk({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:admin",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:admin",
        },
      ],
    });
    await clearOrgMembersCacheEntry(user.orgId, user.userId);

    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.userId);
    expect(result?.orgId).toBe(user.orgId);
    expect(result?.orgRole).toBe("admin");
    expect(result?.capabilities).toContain("agent:read");
  });
});
