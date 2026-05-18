import { describe, it, expect } from "vitest";
import { googleMapsHandler } from "@vm0/connectors/oauth-providers/providers/google-maps-handler";

describe("connector/providers/google-maps", () => {
  describe("buildAuthUrl", () => {
    it("throws because Google Maps does not support OAuth", async () => {
      await expect(async () => {
        await googleMapsHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Google Maps does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Google Maps does not support OAuth", async () => {
      await expect(async () => {
        await googleMapsHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Google Maps does not support OAuth");
    });
  });
});
