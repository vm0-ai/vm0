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
      "artifact:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`);

    expect(result).toBeNull();
  });

  it("should accept sandbox token with matching capability", async () => {
    const token = await generateSandboxToken("user-123", "run-456", [
      "artifact:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "artifact:read",
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
    expect(result?.capabilities).toContain("artifact:read");
  });

  it("should reject sandbox token without matching capability", async () => {
    const token = await generateSandboxToken("user-123", "run-456", [
      "artifact:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "artifact:write",
    });

    expect(result).toBeNull();
  });

  it("should reject sandbox token with no capabilities", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "artifact:read",
    });

    expect(result).toBeNull();
  });

  it("should return Clerk session auth regardless of requiredCapability", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk-user",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getAuthContext(undefined, {
      requiredCapability: "artifact:read",
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

  it("should accept sandbox token with any capability", async () => {
    const token = await generateSandboxToken("user-123", "run-456", [
      "agent:read",
    ]);
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.runId).toBe("run-456");
    expect(result?.capabilities).toContain("agent:read");
  });

  it("should accept sandbox token with multiple capabilities", async () => {
    const token = await generateSandboxToken("user-123", "run-456", [
      "artifact:read",
      "agent:write",
    ]);
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.capabilities).toContain("artifact:read");
    expect(result?.capabilities).toContain("agent:write");
  });

  it("should reject sandbox token with no capabilities", async () => {
    const token = await generateSandboxToken("user-123", "run-456");
    const result = await getAuthContext(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(result).toBeNull();
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

describe("getAuthContext auth() call optimization", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should not call auth() when sandbox token is provided", async () => {
    const token = await generateSandboxToken("user-1", "run-1", [
      "artifact:read",
    ]);
    await getAuthContext(`Bearer ${token}`, {
      requiredCapability: "artifact:read",
    });
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("should not call auth() when sandbox token is rejected", async () => {
    const token = await generateSandboxToken("user-1", "run-1", [
      "artifact:read",
    ]);
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

  it("should call auth() for unknown Bearer token", async () => {
    await getAuthContext("Bearer unknown_token_format");
    expect(mockAuth).toHaveBeenCalled();
  });
});
