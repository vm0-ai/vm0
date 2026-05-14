import { describe, it, expect } from "vitest";
import { squareHandler } from "@vm0/connectors/oauth-providers/providers/square-handler";

describe("connector/providers/square", () => {
  describe("buildAuthUrl", () => {
    it("throws because square does not support OAuth", async () => {
      await expect(async () => {
        await squareHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Square does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because square does not support OAuth", async () => {
      await expect(async () => {
        await squareHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Square does not support OAuth");
    });
  });
});
