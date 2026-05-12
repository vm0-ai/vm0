import { describe, it, expect } from "vitest";
import { heliconeHandler } from "@vm0/connectors/oauth-providers/providers/helicone-handler";

describe("connector/providers/helicone", () => {
  describe("buildAuthUrl", () => {
    it("throws because helicone does not support OAuth", async () => {
      await expect(async () => {
        await heliconeHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Helicone does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because helicone does not support OAuth", async () => {
      await expect(async () => {
        await heliconeHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Helicone does not support OAuth");
    });
  });
});
