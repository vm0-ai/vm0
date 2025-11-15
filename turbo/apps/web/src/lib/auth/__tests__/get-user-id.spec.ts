import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { getUserId } from "../get-user-id";

vi.mock("@clerk/nextjs/server");

describe("getUserId", () => {
  const mockAuth = vi.mocked(auth);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return userId when user is authenticated", async () => {
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
