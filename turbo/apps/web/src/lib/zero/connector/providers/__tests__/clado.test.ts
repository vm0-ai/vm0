import { describe, it, expect } from "vitest";
import { cladoHandler } from "@vm0/connectors/oauth-providers/providers/clado-handler";

describe("connector/providers/clado", () => {
  describe("buildAuthUrl", () => {
    it("throws because Clado does not support OAuth", async () => {
      await expect(async () => {
        await cladoHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Clado does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Clado does not support OAuth", async () => {
      await expect(async () => {
        await cladoHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Clado does not support OAuth");
    });
  });
});
