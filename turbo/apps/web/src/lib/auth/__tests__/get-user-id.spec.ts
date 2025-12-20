import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { getUserId } from "../get-user-id";
import * as editionModule from "../../edition";

vi.mock("@clerk/nextjs/server");
vi.mock("next/headers");
vi.mock("../../edition");

describe("getUserId", () => {
  const mockAuth = vi.mocked(auth);
  const mockHeaders = vi.mocked(headers);
  const mockIsCommunityEdition = vi.mocked(editionModule.isCommunityEdition);
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Default: Cloud Edition
    mockIsCommunityEdition.mockReturnValue(false);
    // Default mock for headers - no Authorization header
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Awaited<ReturnType<typeof headers>>);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Cloud Edition", () => {
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

  describe("Community Edition", () => {
    beforeEach(() => {
      mockIsCommunityEdition.mockReturnValue(true);
    });

    describe("with VM0_COMMUNITY_AUTH_TOKEN configured", () => {
      beforeEach(() => {
        process.env.VM0_COMMUNITY_AUTH_TOKEN = "test-secret-token";
      });

      it("should return 'community_edition' when token matches", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Bearer test-secret-token"),
        } as unknown as Awaited<ReturnType<typeof headers>>);

        const result = await getUserId();

        expect(result).toBe("community_edition");
        expect(mockAuth).not.toHaveBeenCalled();
      });

      it("should return null when token does not match", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Bearer wrong-token"),
        } as unknown as Awaited<ReturnType<typeof headers>>);

        const result = await getUserId();

        expect(result).toBeNull();
        expect(mockAuth).not.toHaveBeenCalled();
      });

      it("should return null when Authorization header is missing", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(null),
        } as unknown as Awaited<ReturnType<typeof headers>>);

        const result = await getUserId();

        expect(result).toBeNull();
        expect(mockAuth).not.toHaveBeenCalled();
      });

      it("should return null when Authorization header has wrong format", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Basic test-secret-token"),
        } as unknown as Awaited<ReturnType<typeof headers>>);

        const result = await getUserId();

        expect(result).toBeNull();
        expect(mockAuth).not.toHaveBeenCalled();
      });
    });

    describe("without VM0_COMMUNITY_AUTH_TOKEN (open access)", () => {
      beforeEach(() => {
        delete process.env.VM0_COMMUNITY_AUTH_TOKEN;
      });

      it("should return 'community_edition' without any auth header", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(null),
        } as unknown as Awaited<ReturnType<typeof headers>>);

        const result = await getUserId();

        expect(result).toBe("community_edition");
        expect(mockAuth).not.toHaveBeenCalled();
      });

      it("should return 'community_edition' even with random auth header", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Bearer random-token"),
        } as unknown as Awaited<ReturnType<typeof headers>>);

        const result = await getUserId();

        expect(result).toBe("community_edition");
        expect(mockAuth).not.toHaveBeenCalled();
      });
    });
  });
});
