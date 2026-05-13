import { describe, it, expect } from "vitest";
import { testrailHandler } from "@vm0/connectors/oauth-providers/providers/testrail-handler";

describe("connector/providers/testrail", () => {
  describe("buildAuthUrl", () => {
    it("throws because testrail does not support OAuth", async () => {
      await expect(async () => {
        await testrailHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("TestRail does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because testrail does not support OAuth", async () => {
      await expect(async () => {
        await testrailHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("TestRail does not support OAuth");
    });
  });
});
