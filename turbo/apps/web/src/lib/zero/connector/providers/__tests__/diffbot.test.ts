import { describe, it, expect } from "vitest";
import { diffbotHandler } from "@vm0/connectors/oauth-providers/providers/diffbot-handler";

describe("connector/providers/diffbot", () => {
  describe("buildAuthUrl", () => {
    it("throws because Diffbot does not support OAuth", async () => {
      await expect(async () => {
        await diffbotHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Diffbot does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Diffbot does not support OAuth", async () => {
      await expect(async () => {
        await diffbotHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Diffbot does not support OAuth");
    });
  });
});
