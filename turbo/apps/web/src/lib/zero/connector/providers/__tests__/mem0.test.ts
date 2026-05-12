import { describe, it, expect } from "vitest";
import { mem0Handler } from "@vm0/connectors/oauth-providers/providers/mem0-handler";

describe("connector/providers/mem0", () => {
  describe("buildAuthUrl", () => {
    it("throws because mem0 does not support OAuth", async () => {
      await expect(async () => {
        await mem0Handler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Mem0 does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because mem0 does not support OAuth", async () => {
      await expect(async () => {
        await mem0Handler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Mem0 does not support OAuth");
    });
  });
});
