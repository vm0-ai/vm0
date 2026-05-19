import { describe, it, expect } from "vitest";
import { mossHandler } from "@vm0/connectors/oauth-providers/providers/moss-handler";

describe("connector/providers/moss", () => {
  describe("buildAuthUrl", () => {
    it("throws because moss does not support OAuth", async () => {
      await expect(async () => {
        await mossHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Moss does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because moss does not support OAuth", async () => {
      await expect(async () => {
        await mossHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Moss does not support OAuth");
    });
  });
});
