import { describe, it, expect } from "vitest";
import { duffelHandler } from "../duffel-handler";

describe("connector/providers/duffel", () => {
  describe("buildAuthUrl", () => {
    it("throws because duffel does not support OAuth", async () => {
      await expect(async () => {
        await duffelHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Duffel does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because duffel does not support OAuth", async () => {
      await expect(async () => {
        await duffelHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Duffel does not support OAuth");
    });
  });
});
