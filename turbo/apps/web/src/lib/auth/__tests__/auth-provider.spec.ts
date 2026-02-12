import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { reloadEnv } from "../../../env";
import {
  getAuthProvider,
  resetAuthProvider,
  SELF_HOSTED_USER_ID,
} from "../auth-provider";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));

const mockAuth = vi.mocked(auth);
const mockClerkClient = vi.mocked(clerkClient);

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthProvider();
  });

  describe("getAuthProvider (SaaS mode)", () => {
    it("should delegate getUserId to Clerk", async () => {
      mockAuth.mockResolvedValue({
        userId: "clerk_user_123",
      } as Awaited<ReturnType<typeof auth>>);

      const provider = getAuthProvider();
      const userId = await provider.getUserId();

      expect(userId).toBe("clerk_user_123");
      expect(userId).not.toBe(SELF_HOSTED_USER_ID);
    });

    it("should return null when no Clerk session", async () => {
      mockAuth.mockResolvedValue({
        userId: null,
      } as Awaited<ReturnType<typeof auth>>);

      const provider = getAuthProvider();
      const userId = await provider.getUserId();

      expect(userId).toBeNull();
    });

    it("should fetch primary email from Clerk API", async () => {
      const primaryEmailId = "email_primary";
      mockClerkClient.mockResolvedValue({
        users: {
          getUser: vi.fn().mockResolvedValue({
            primaryEmailAddressId: primaryEmailId,
            emailAddresses: [
              { id: "email_other", emailAddress: "other@example.com" },
              { id: primaryEmailId, emailAddress: "primary@example.com" },
            ],
          }),
        },
      } as unknown as Awaited<ReturnType<typeof clerkClient>>);

      const provider = getAuthProvider();
      const email = await provider.getUserEmail("user_abc");

      expect(email).toBe("primary@example.com");
    });

    it("should return empty string when no email found", async () => {
      mockClerkClient.mockResolvedValue({
        users: {
          getUser: vi.fn().mockResolvedValue({
            primaryEmailAddressId: "nonexistent",
            emailAddresses: [],
          }),
        },
      } as unknown as Awaited<ReturnType<typeof clerkClient>>);

      const provider = getAuthProvider();
      const email = await provider.getUserEmail("user_abc");

      expect(email).toBe("");
    });
  });

  describe("getAuthProvider (self-hosted mode)", () => {
    beforeEach(() => {
      vi.stubEnv("SELF_HOSTED", "true");
      reloadEnv();
      resetAuthProvider();
    });

    it("should return the default user ID", async () => {
      const provider = getAuthProvider();
      const userId = await provider.getUserId();

      expect(userId).toBe(SELF_HOSTED_USER_ID);
      expect(userId).toBe("00000000-0000-0000-0000-000000000000");
    });

    it("should return the default email", async () => {
      const provider = getAuthProvider();
      const email = await provider.getUserEmail("any-id");

      expect(email).toBe("admin@localhost");
    });

    it("should not call Clerk", async () => {
      const provider = getAuthProvider();
      await provider.getUserId();

      expect(mockAuth).not.toHaveBeenCalled();
    });

    it("should return consistent values on repeated calls", async () => {
      const provider = getAuthProvider();
      const id1 = await provider.getUserId();
      const id2 = await provider.getUserId();

      expect(id1).toBe(id2);
    });
  });

  describe("SELF_HOSTED_USER_ID", () => {
    it("should be a valid UUID", () => {
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(SELF_HOSTED_USER_ID).toMatch(uuidRegex);
    });
  });
});
