import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { getUserId } from "../get-user-id";

vi.mock("@clerk/nextjs/server");
vi.mock("next/headers");

describe("getUserId", () => {
  const mockAuth = vi.mocked(auth);
  const mockHeaders = vi.mocked(headers);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for headers - no Authorization header
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Awaited<ReturnType<typeof headers>>);
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
});
