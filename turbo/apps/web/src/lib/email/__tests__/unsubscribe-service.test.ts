import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { insertTestUser } from "../../../__tests__/api-test-helpers";
import { isUserUnsubscribed, unsubscribeUser } from "../unsubscribe-service";

const context = testContext();

describe("unsubscribe-service", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("isUserUnsubscribed", () => {
    it("returns false for unknown user (no row)", async () => {
      await context.setupUser();
      const userId = uniqueId("unknown-user");
      expect(await isUserUnsubscribed(userId)).toBe(false);
    });

    it("returns false for user with default value", async () => {
      const { userId } = await context.setupUser();
      await insertTestUser(userId);
      expect(await isUserUnsubscribed(userId)).toBe(false);
    });

    it("returns true from Clerk fallback when DB has false", async () => {
      const { userId } = await context.setupUser();
      await insertTestUser(userId);

      // Override Clerk getUser to return email_unsubscribed: true
      const client = await clerkClient();
      vi.mocked(client.users.getUser).mockResolvedValueOnce({
        publicMetadata: { email_unsubscribed: true },
      } as unknown as Awaited<ReturnType<typeof client.users.getUser>>);

      expect(await isUserUnsubscribed(userId)).toBe(true);

      // Verify backfill happened (fire-and-forget, wait a tick)
      await new Promise((r) => setTimeout(r, 50));
      expect(await isUserUnsubscribed(userId)).toBe(true);
    });

    it("skips Clerk call when DB already has true", async () => {
      const { userId } = await context.setupUser();
      await insertTestUser(userId);
      await unsubscribeUser(userId);

      const client = await clerkClient();

      expect(await isUserUnsubscribed(userId)).toBe(true);
      expect(client.users.getUser).not.toHaveBeenCalled();
    });

    it("returns false when neither DB nor Clerk has true", async () => {
      const { userId } = await context.setupUser();
      await insertTestUser(userId);

      // Default Clerk mock returns no publicMetadata, so fallback returns false
      expect(await isUserUnsubscribed(userId)).toBe(false);
    });
  });

  describe("unsubscribeUser", () => {
    it("creates user row and sets email_unsubscribed to true", async () => {
      await context.setupUser();
      const userId = uniqueId("new-unsub-user");

      await unsubscribeUser(userId);

      expect(await isUserUnsubscribed(userId)).toBe(true);
    });

    it("updates existing user row", async () => {
      const { userId } = await context.setupUser();
      await insertTestUser(userId);
      expect(await isUserUnsubscribed(userId)).toBe(false);

      await unsubscribeUser(userId);

      expect(await isUserUnsubscribed(userId)).toBe(true);
    });

    it("is idempotent", async () => {
      await context.setupUser();
      const userId = uniqueId("idempotent-user");

      await unsubscribeUser(userId);
      await unsubscribeUser(userId);

      expect(await isUserUnsubscribed(userId)).toBe(true);
    });
  });
});
