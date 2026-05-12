import { describe, it, expect } from "vitest";
import { plainHandler } from "@vm0/connectors/oauth-providers/providers/plain-handler";

describe("connector/providers/plain", () => {
  describe("buildAuthUrl", () => {
    it("throws because plain does not support OAuth", async () => {
      await expect(async () => {
        await plainHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Plain does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because plain does not support OAuth", async () => {
      await expect(async () => {
        await plainHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Plain does not support OAuth");
    });
  });
});
