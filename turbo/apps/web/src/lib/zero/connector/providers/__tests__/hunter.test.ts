import { describe, it, expect } from "vitest";
import { hunterHandler } from "@vm0/connectors/oauth-providers/providers/hunter-handler";

describe("connector/providers/hunter", () => {
  describe("buildAuthUrl", () => {
    it("throws because Hunter does not support OAuth", async () => {
      await expect(async () => {
        await hunterHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Hunter does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Hunter does not support OAuth", async () => {
      await expect(async () => {
        await hunterHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Hunter does not support OAuth");
    });
  });
});
