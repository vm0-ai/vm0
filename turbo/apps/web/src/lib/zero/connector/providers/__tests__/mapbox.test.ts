import { describe, it, expect } from "vitest";
import { mapboxHandler } from "@vm0/connectors/oauth-providers/providers/mapbox-handler";

describe("connector/providers/mapbox", () => {
  describe("buildAuthUrl", () => {
    it("throws because Mapbox does not support OAuth", async () => {
      await expect(async () => {
        await mapboxHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Mapbox does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Mapbox does not support OAuth", async () => {
      await expect(async () => {
        await mapboxHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Mapbox does not support OAuth");
    });
  });
});
