import { describe, it, expect } from "vitest";
import { msg9Handler } from "@vm0/connectors/oauth-providers/providers/msg9-handler";

describe("connector/providers/msg9", () => {
  describe("buildAuthUrl", () => {
    it("throws because msg9 does not support OAuth", async () => {
      await expect(async () => {
        await msg9Handler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("msg9 does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because msg9 does not support OAuth", async () => {
      await expect(async () => {
        await msg9Handler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("msg9 does not support OAuth");
    });
  });
});
