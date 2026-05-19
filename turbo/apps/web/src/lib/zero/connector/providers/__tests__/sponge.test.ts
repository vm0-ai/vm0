import { describe, it, expect } from "vitest";
import { spongeHandler } from "@vm0/connectors/oauth-providers/providers/sponge-handler";

describe("connector/providers/sponge", () => {
  describe("buildAuthUrl", () => {
    it("throws because sponge does not support OAuth", async () => {
      await expect(async () => {
        await spongeHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Sponge does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because sponge does not support OAuth", async () => {
      await expect(async () => {
        await spongeHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Sponge does not support OAuth");
    });
  });
});
