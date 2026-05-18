import { describe, it, expect } from "vitest";
import { sunoHandler } from "@vm0/connectors/oauth-providers/providers/suno-handler";

describe("connector/providers/suno", () => {
  describe("buildAuthUrl", () => {
    it("throws because Suno does not support OAuth", async () => {
      await expect(async () => {
        await sunoHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Suno does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Suno does not support OAuth", async () => {
      await expect(async () => {
        await sunoHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Suno does not support OAuth");
    });
  });
});
