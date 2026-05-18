import { describe, it, expect } from "vitest";
import { openweatherHandler } from "@vm0/connectors/oauth-providers/providers/openweather-handler";

describe("connector/providers/openweather", () => {
  describe("buildAuthUrl", () => {
    it("throws because OpenWeather does not support OAuth", async () => {
      await expect(async () => {
        await openweatherHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("OpenWeather does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because OpenWeather does not support OAuth", async () => {
      await expect(async () => {
        await openweatherHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("OpenWeather does not support OAuth");
    });
  });
});
