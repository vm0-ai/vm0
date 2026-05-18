import { describe, it, expect } from "vitest";
import { reductoHandler } from "@vm0/connectors/oauth-providers/providers/reducto-handler";

describe("connector/providers/reducto", () => {
  describe("buildAuthUrl", () => {
    it("throws because Reducto does not support OAuth", async () => {
      await expect(async () => {
        await reductoHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Reducto does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Reducto does not support OAuth", async () => {
      await expect(async () => {
        await reductoHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Reducto does not support OAuth");
    });
  });
});
