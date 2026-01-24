import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { getUserId } from "../get-user-id";

vi.mock("@clerk/nextjs/server");

describe("getUserId", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return userId when user is authenticated via Clerk", async () => {
    const testUserId = "user_123";
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId();

    expect(result).toBe(testUserId);
    expect(mockAuth).toHaveBeenCalledOnce();
  });

  it("should return null when user is not authenticated", async () => {
    mockAuth.mockResolvedValue({
      userId: null,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId();

    expect(result).toBeNull();
    expect(mockAuth).toHaveBeenCalledOnce();
  });

  it("should return null for unknown Bearer token formats", async () => {
    // Unknown token format (not vm0_live_ and not sandbox token)
    const result = await getUserId("Bearer unknown_format_token");

    expect(result).toBeNull();
    // Clerk auth should not be called when Bearer token is provided
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("should fall back to Clerk auth when Authorization header is not Bearer", async () => {
    const testUserId = "clerk_user_789";
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId("Basic sometoken");

    expect(result).toBe(testUserId);
    expect(mockAuth).toHaveBeenCalledOnce();
  });

  it("should fall back to Clerk auth when no authHeader is provided", async () => {
    const testUserId = "clerk_user_default";
    mockAuth.mockResolvedValue({
      userId: testUserId,
    } as Awaited<ReturnType<typeof auth>>);

    const result = await getUserId();

    expect(result).toBe(testUserId);
    expect(mockAuth).toHaveBeenCalledOnce();
  });
});
