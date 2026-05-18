import { describe, it, expect } from "vitest";
import { builtwithHandler } from "@vm0/connectors/oauth-providers/providers/builtwith-handler";

describe("connector/providers/builtwith", () => {
  describe("buildAuthUrl", () => {
    it("throws because BuiltWith does not support OAuth", async () => {
      await expect(async () => {
        await builtwithHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("BuiltWith does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because BuiltWith does not support OAuth", async () => {
      await expect(async () => {
        await builtwithHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("BuiltWith does not support OAuth");
    });
  });
});
