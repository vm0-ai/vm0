import { describe, it, expect } from "vitest";
import { seedanceHandler } from "../seedance-handler";

describe("connector/providers/seedance", () => {
  describe("buildAuthUrl", () => {
    it("throws because seedance does not support OAuth", async () => {
      await expect(async () => {
        await seedanceHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Seedance does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because seedance does not support OAuth", async () => {
      await expect(async () => {
        await seedanceHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Seedance does not support OAuth");
    });
  });
});
