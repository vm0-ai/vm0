import { describe, it, expect } from "vitest";
import { altium365Handler } from "@vm0/connectors/oauth-providers/providers/altium-365-handler";

describe("connector/providers/altium-365", () => {
  describe("buildAuthUrl", () => {
    it("throws because altium-365 does not support OAuth", async () => {
      await expect(async () => {
        await altium365Handler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Altium 365 does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because altium-365 does not support OAuth", async () => {
      await expect(async () => {
        await altium365Handler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Altium 365 does not support OAuth");
    });
  });
});
