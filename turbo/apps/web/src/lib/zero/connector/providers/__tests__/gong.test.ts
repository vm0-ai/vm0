import { describe, it, expect } from "vitest";
import { gongHandler } from "@vm0/connectors/oauth-providers/providers/gong-handler";

describe("connector/providers/gong", () => {
  describe("buildAuthUrl", () => {
    it("throws because gong does not support OAuth", async () => {
      await expect(async () => {
        await gongHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Gong does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because gong does not support OAuth", async () => {
      await expect(async () => {
        await gongHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Gong does not support OAuth");
    });
  });
});
