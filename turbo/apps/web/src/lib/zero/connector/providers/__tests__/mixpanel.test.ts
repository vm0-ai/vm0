import { describe, it, expect } from "vitest";
import { mixpanelHandler } from "../mixpanel-handler";

describe("connector/providers/mixpanel", () => {
  describe("buildAuthUrl", () => {
    it("throws because Mixpanel does not support OAuth", async () => {
      await expect(async () => {
        await mixpanelHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Mixpanel does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Mixpanel does not support OAuth", async () => {
      await expect(async () => {
        await mixpanelHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Mixpanel does not support OAuth");
    });
  });
});
