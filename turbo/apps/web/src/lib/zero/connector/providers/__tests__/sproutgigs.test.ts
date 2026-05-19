import { describe, it, expect } from "vitest";
import { sproutgigsHandler } from "@vm0/connectors/oauth-providers/providers/sproutgigs-handler";

describe("connector/providers/sproutgigs", () => {
  describe("buildAuthUrl", () => {
    it("throws because SproutGigs does not support OAuth", async () => {
      await expect(async () => {
        await sproutgigsHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("SproutGigs does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because SproutGigs does not support OAuth", async () => {
      await expect(async () => {
        await sproutgigsHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("SproutGigs does not support OAuth");
    });
  });
});
