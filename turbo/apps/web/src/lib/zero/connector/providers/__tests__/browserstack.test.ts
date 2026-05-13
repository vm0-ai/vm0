import { describe, it, expect } from "vitest";
import { browserstackHandler } from "@vm0/connectors/oauth-providers/providers/browserstack-handler";

describe("connector/providers/browserstack", () => {
  describe("buildAuthUrl", () => {
    it("throws because browserstack does not support OAuth", async () => {
      await expect(async () => {
        await browserstackHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("BrowserStack does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because browserstack does not support OAuth", async () => {
      await expect(async () => {
        await browserstackHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("BrowserStack does not support OAuth");
    });
  });
});
