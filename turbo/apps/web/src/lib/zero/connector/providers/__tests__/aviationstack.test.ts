import { describe, it, expect } from "vitest";
import { aviationstackHandler } from "@vm0/connectors/oauth-providers/providers/aviationstack-handler";

describe("connector/providers/aviationstack", () => {
  describe("buildAuthUrl", () => {
    it("throws because AviationStack does not support OAuth", async () => {
      await expect(async () => {
        await aviationstackHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("AviationStack does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because AviationStack does not support OAuth", async () => {
      await expect(async () => {
        await aviationstackHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("AviationStack does not support OAuth");
    });
  });
});
