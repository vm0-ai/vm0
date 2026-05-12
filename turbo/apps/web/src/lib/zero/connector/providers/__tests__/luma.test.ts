import { describe, it, expect } from "vitest";
import { lumaHandler } from "@vm0/connectors/oauth-providers/providers/luma-handler";

describe("connector/providers/luma", () => {
  describe("buildAuthUrl", () => {
    it("throws because luma does not support OAuth", async () => {
      await expect(async () => {
        await lumaHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Luma does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because luma does not support OAuth", async () => {
      await expect(async () => {
        await lumaHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Luma does not support OAuth");
    });
  });
});
