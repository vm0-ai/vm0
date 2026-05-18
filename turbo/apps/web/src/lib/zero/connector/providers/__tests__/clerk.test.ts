import { describe, it, expect } from "vitest";
import { clerkHandler } from "@vm0/connectors/oauth-providers/providers/clerk-handler";

describe("connector/providers/clerk", () => {
  describe("buildAuthUrl", () => {
    it("throws because clerk does not support OAuth", async () => {
      await expect(async () => {
        await clerkHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Clerk does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because clerk does not support OAuth", async () => {
      await expect(async () => {
        await clerkHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Clerk does not support OAuth");
    });
  });
});
