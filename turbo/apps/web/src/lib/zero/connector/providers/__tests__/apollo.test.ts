import { describe, it, expect } from "vitest";
import { apolloHandler } from "@vm0/connectors/oauth-providers/providers/apollo-handler";

describe("connector/providers/apollo", () => {
  describe("buildAuthUrl", () => {
    it("throws because apollo does not support OAuth", async () => {
      await expect(async () => {
        await apolloHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Apollo does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because apollo does not support OAuth", async () => {
      await expect(async () => {
        await apolloHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Apollo does not support OAuth");
    });
  });
});
