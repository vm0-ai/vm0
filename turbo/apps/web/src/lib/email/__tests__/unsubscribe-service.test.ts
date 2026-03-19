import { describe, it, expect, beforeEach } from "vitest";
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
