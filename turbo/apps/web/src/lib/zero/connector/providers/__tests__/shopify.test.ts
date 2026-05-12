import { describe, it, expect } from "vitest";
import { shopifyHandler } from "@vm0/connectors/oauth-providers/providers/shopify-handler";

describe("connector/providers/shopify", () => {
  describe("buildAuthUrl", () => {
    it("throws because shopify does not support OAuth", async () => {
      await expect(async () => {
        await shopifyHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Shopify does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because shopify does not support OAuth", async () => {
      await expect(async () => {
        await shopifyHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Shopify does not support OAuth");
    });
  });
});
