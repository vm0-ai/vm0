import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { getAuthContext, getUserId } from "../get-auth-context";
import { generateSandboxToken, generateZeroToken } from "../sandbox-token";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { clearOrgMembersCacheEntry } from "../../../__tests__/api-test-helpers";
import { testContext } from "../../../__tests__/test-helpers";

const context = testContext();

describe("getUserId", () => {
  const mockAuth = vi.mocked(auth);

  it("should return userId from auth provider session", async () => {
    const testUserId = "user_123";
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId();

    expect(result).toBe(testUserId);
  });

  it("should return null when no session and no auth header", async () => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId();

    expect(result).toBeNull();
  });

  it("should return userId from session even with non-Bearer auth header", async () => {
    const testUserId = "clerk_user_789";
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId("Basic sometoken");

    expect(result).toBe(testUserId);
  });

  it("should return null when no session and non-Bearer auth header", async () => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId("Basic sometoken");

    expect(result).toBeNull();
  });
});

describe("getAuthContext with requiredCapability", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should reject sandbox token without requiredCapability (backward compat)", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });

  it("should reject sandbox token with requiredCapability (sandbox tokens have no capabilities)", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).toBeNull();
  });

  it("should reject sandbox token without matching capability", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:write",
    });

    expect(result).toBeNull();
  });

  it("should reject sandbox token with no capabilities", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).toBeNull();
  });

  it("should return Clerk session auth regardless of requiredCapability", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk-user",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext(undefined, {
      requiredCapability: "agent:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("clerk-user");
    expect(result?.capabilities).toBeUndefined();
  });
});

describe("getAuthContext with acceptAnySandboxCapability", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should accept sandbox token with acceptAnySandboxCapability", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
  });

  it("should accept sandbox token without capabilities via acceptAnySandboxCapability", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
  });

  it("should accept sandbox token with no capabilities when acceptAnySandboxCapability is true", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
  });

  it("should return Clerk session auth regardless of acceptAnySandboxCapability", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk-user",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext(undefined, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("clerk-user");
    expect(result?.capabilities).toBeUndefined();
  });
});

describe("getAuthContext org fields from Clerk session", () => {
  const mockAuth = vi.mocked(auth);

  it("should populate orgId, orgRole, sessionClaims from Clerk session", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_123",
      orgId: "org_456",
      orgRole: "org:admin",
      sessionClaims: { custom_field: "test-value" },
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext();

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user_123");
    expect(result?.orgId).toBe("org_456");
    expect(result?.orgRole).toBe("admin");
    expect(result?.sessionClaims?.custom_field).toBe("test-value");
  });

  it("should map org:member role to member", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_123",
      orgId: "org_456",
      orgRole: "org:member",
      sessionClaims: {},
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext();

    expect(result?.orgRole).toBe("member");
  });

  it("should leave org fields undefined when not in Clerk session", async () => {
    mockAuth.mockResolvedValue({
      userId: "user_123",
      orgId: null,
      orgRole: null,
      sessionClaims: {},
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext();

    expect(result?.userId).toBe("user_123");
    expect(result?.orgId).toBeUndefined();
    expect(result?.orgRole).toBeUndefined();
    expect(result?.sessionClaims?.custom_field).toBeUndefined();
  });

  it("should not populate org fields for sandbox tokens", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result?.userId).toBe("user-123");
    expect(result?.orgId).toBeUndefined();
    expect(result?.orgRole).toBeUndefined();
    expect(result?.sessionClaims).toBeUndefined();
  });
});

describe("getAuthContext auth() call optimization", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    context.setupMocks();
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should not call auth() when sandbox token is provided", async () => {
    const token = await generateSandboxToken("user-1", "run-1");
    await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("should not call auth() when sandbox token is rejected", async () => {
    const token = await generateSandboxToken("user-1", "run-1");
    await getAuthContext(`Bearer ${token}`);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("should call auth() when no auth header provided", async () => {
    await getAuthContext();
    expect(mockAuth).toHaveBeenCalled();
  });

  it("should call auth() when non-Bearer auth header provided", async () => {
    await getAuthContext("Basic sometoken");
    expect(mockAuth).toHaveBeenCalled();
  });

  it("should call auth() for unknown Bearer token (Clerk session fallback)", async () => {
    // Clerk's session.getToken() hands the platform api-client a standard
    // JWT that the web api-client forwards as `Authorization: Bearer eyJ...`.
    // That shape matches neither vm0_pat_ nor vm0_sandbox_ prefixes, so it
    // must fall through to Clerk session auth, not 401.
    await getAuthContext("Bearer unknown_token_format");
    expect(mockAuth).toHaveBeenCalled();
  });

  it("should resolve Clerk session auth when a Clerk-shape JWT Bearer is presented", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk-user",
    } as Awaited<ReturnType<typeof auth>>);

    // clerkMiddleware populates auth() from the Authorization header itself;
    // getAuthContext must defer to it for any non-vm0 Bearer shape.
    const result = await getAuthContext(
      "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
    );
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("clerk-user");
    expect(result?.tokenType).toBe("session");
  });

  it("should not call auth() when zero token is provided", async () => {
    mockClerk({
      userId: "user-1",
      clerkOrgs: [{ id: "org-1", slug: "org-1", name: "org-1" }],
    });
    await clearOrgMembersCacheEntry("org-1", "user-1");
    const token = await generateZeroToken("user-1", "run-1", "org-1");
    await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });
    expect(mockAuth).not.toHaveBeenCalled();
  });
});

describe("getAuthContext with zero token and requiredCapability", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(async () => {
    context.setupMocks();
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
    mockClerk({
      userId: "user-123",
      clerkOrgs: [{ id: "org-789", slug: "org-789", name: "org-789" }],
    });
    await clearOrgMembersCacheEntry("org-789", "user-123");
  });

  it("should accept zero token with matching capability", async () => {
    const token = await generateZeroToken("user-123", "run-456", "org-789");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
    expect(result?.orgId).toBe("org-789");
    expect(result?.capabilities).toContain("agent:read");
  });

  it("should reject zero token without requiredCapability opt-in", async () => {
    const token = await generateZeroToken("user-123", "run-456", "org-789");
    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });

  it("should populate orgId from zero token", async () => {
    const token = await generateZeroToken("user-123", "run-456", "org-789");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(result?.orgId).toBe("org-789");
  });
});

describe("getAuthContext with zero token and acceptAnySandboxCapability", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(async () => {
    context.setupMocks();
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
    mockClerk({
      userId: "user-123",
      clerkOrgs: [{ id: "org-789", slug: "org-789", name: "org-789" }],
    });
    await clearOrgMembersCacheEntry("org-789", "user-123");
  });

  it("should accept zero token on infra routes", async () => {
    const token = await generateZeroToken("user-123", "run-456", "org-789");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
    expect(result?.orgId).toBe("org-789");
    expect(result?.capabilities).toContain("agent:read");
  });

  it("should include all zero capabilities", async () => {
    const token = await generateZeroToken("user-123", "run-456", "org-789");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result?.capabilities).toEqual(
      expect.arrayContaining([
        "agent:read",
        "agent:write",
        "agent-run:read",
        "schedule:read",
        "schedule:write",
        "slack:write",
      ]),
    );
    expect(result?.capabilities).not.toContain("agent-run:write");
    expect(result?.capabilities).not.toContain("agent:delete");
  });
});
