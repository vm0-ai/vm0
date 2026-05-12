import { describe, it, expect } from "vitest";
import { etsyHandler } from "@vm0/connectors/oauth-providers/providers/etsy-handler";

describe("connector/providers/etsy", () => {
  describe("buildAuthUrl", () => {
    it("throws because etsy does not support OAuth", async () => {
      await expect(async () => {
        await etsyHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Etsy does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because etsy does not support OAuth", async () => {
      await expect(async () => {
        await etsyHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Etsy does not support OAuth");
    });
  });
});
