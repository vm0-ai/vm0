import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, isAuthError } from "../require-auth";
import { generateSandboxToken } from "../sandbox-token";

describe("requireAuth", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);
  });

  it("should return AuthContext for valid Clerk session", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk-user",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await requireAuth(undefined, {
      requiredCapability: "agent:read",
    });

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.userId).toBe("clerk-user");
    }
  });

  it("should return AuthContext for sandbox token with matching capability", async () => {
    const token = await generateSandboxToken("user-1", "run-1", ["agent:read"]);

    const result = await requireAuth(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.userId).toBe("user-1");
      expect(result.runId).toBe("run-1");
      expect(result.capabilities).toContain("agent:read");
    }
  });

  it("should return 403 for sandbox token missing required capability", async () => {
    const token = await generateSandboxToken("user-1", "run-1", ["agent:read"]);

    const result = await requireAuth(`Bearer ${token}`, {
      requiredCapability: "agent:write",
    });

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("FORBIDDEN");
      expect(result.body.error.message).toBe(
        "Missing required capability: agent:write",
      );
    }
  });

  it("should return 403 for sandbox token with no capabilities", async () => {
    const token = await generateSandboxToken("user-1", "run-1");

    const result = await requireAuth(`Bearer ${token}`, {
      requiredCapability: "agent:read",
    });

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("FORBIDDEN");
      expect(result.body.error.message).toBe(
        "Missing required capability: agent:read",
      );
    }
  });

  it("should return 403 for sandbox token on uncovered endpoint", async () => {
    const token = await generateSandboxToken("user-1", "run-1", ["agent:read"]);

    // No requiredCapability = uncovered endpoint
    const result = await requireAuth(`Bearer ${token}`);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("FORBIDDEN");
      expect(result.body.error.message).toBe(
        "This endpoint is not available for sandbox tokens",
      );
    }
  });

  it("should return 403 for acceptAnySandboxCapability with no capabilities", async () => {
    const token = await generateSandboxToken("user-1", "run-1");

    const result = await requireAuth(`Bearer ${token}`, {
      acceptAnySandboxCapability: true,
    });

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("should return 401 for no auth header", async () => {
    const result = await requireAuth(undefined);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      expect(result.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("should return 401 for non-Bearer auth header", async () => {
    const result = await requireAuth("Basic sometoken");

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      expect(result.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("should return 401 for invalid sandbox token", async () => {
    // 3 dot-separated parts looks like JWT but is invalid
    const result = await requireAuth("Bearer invalid.sandbox.token");

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      expect(result.body.error.code).toBe("UNAUTHORIZED");
    }
  });
});

describe("isAuthError", () => {
  it("should return true for error response", () => {
    const error = {
      status: 401 as const,
      body: { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    };
    expect(isAuthError(error)).toBe(true);
  });

  it("should return false for AuthContext", () => {
    const ctx = { userId: "user-1" };
    expect(isAuthError(ctx)).toBe(false);
  });
});
