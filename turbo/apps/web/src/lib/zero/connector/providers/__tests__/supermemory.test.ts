import { describe, it, expect } from "vitest";
import { supermemoryHandler } from "@vm0/connectors/oauth-providers/providers/supermemory-handler";

describe("connector/providers/supermemory", () => {
  describe("buildAuthUrl", () => {
    it("throws because supermemory does not support OAuth", async () => {
      await expect(async () => {
        await supermemoryHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Supermemory does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because supermemory does not support OAuth", async () => {
      await expect(async () => {
        await supermemoryHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Supermemory does not support OAuth");
    });
  });
});
