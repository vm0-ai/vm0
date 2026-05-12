import { describe, it, expect } from "vitest";
import { zepHandler } from "@vm0/connectors/oauth-providers/providers/zep-handler";

describe("connector/providers/zep", () => {
  describe("buildAuthUrl", () => {
    it("throws because zep does not support OAuth", async () => {
      await expect(async () => {
        await zepHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Zep does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because zep does not support OAuth", async () => {
      await expect(async () => {
        await zepHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Zep does not support OAuth");
    });
  });
});
