import { describe, it, expect } from "vitest";
import { klaviyoHandler } from "@vm0/connectors/oauth-providers/providers/klaviyo-handler";

describe("connector/providers/klaviyo", () => {
  describe("buildAuthUrl", () => {
    it("throws because klaviyo does not support OAuth", async () => {
      await expect(async () => {
        await klaviyoHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("klaviyo does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because klaviyo does not support OAuth", async () => {
      await expect(async () => {
        await klaviyoHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("klaviyo does not support OAuth");
    });
  });
});
