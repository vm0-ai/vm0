import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { getAuthContext, getUserId } from "../get-user-id";
import { generateSandboxToken } from "../sandbox-token";

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
    const token = await generateSandboxToken("user-123", "run-456", [
      "volume:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });

  it("should accept sandbox token with matching capability", async () => {
    const token = await generateSandboxToken("user-123", "run-456", [
      "volume:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "volume:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
    expect(result?.capabilities).toContain("volume:read");
  });

  it("should reject sandbox token without matching capability", async () => {
    const token = await generateSandboxToken("user-123", "run-456", [
      "volume:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "artifact:write",
    });

    expect(result).toBeNull();
  });

  it("should reject sandbox token with no capabilities", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "volume:read",
    });

    expect(result).toBeNull();
  });

  it("should return Clerk session auth regardless of requiredCapability", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk-user",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext(undefined, {
      requiredCapability: "volume:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("clerk-user");
    expect(result?.capabilities).toBeUndefined();
  });
});
