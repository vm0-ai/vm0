import { describe, it, expect } from "vitest";
import { dopplerHandler } from "../doppler-handler";

describe("connector/providers/doppler", () => {
  describe("buildAuthUrl", () => {
    it("throws because doppler does not support OAuth", async () => {
      await expect(async () => {
        await dopplerHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Doppler does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because doppler does not support OAuth", async () => {
      await expect(async () => {
        await dopplerHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Doppler does not support OAuth");
    });
  });
});