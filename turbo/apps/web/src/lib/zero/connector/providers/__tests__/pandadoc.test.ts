import { describe, it, expect } from "vitest";
import { pandadocHandler } from "../pandadoc-handler";

describe("connector/providers/pandadoc", () => {
  describe("buildAuthUrl", () => {
    it("throws because PandaDoc does not support OAuth", async () => {
      await expect(async () => {
        await pandadocHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("PandaDoc does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because PandaDoc does not support OAuth", async () => {
      await expect(async () => {
        await pandadocHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("PandaDoc does not support OAuth");
    });
  });
});
