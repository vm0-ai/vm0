import { describe, it, expect } from "vitest";
import { twilioHandler } from "@vm0/connectors/oauth-providers/providers/twilio-handler";

describe("connector/providers/twilio", () => {
  describe("buildAuthUrl", () => {
    it("throws because twilio does not support OAuth", async () => {
      await expect(async () => {
        await twilioHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Twilio does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because twilio does not support OAuth", async () => {
      await expect(async () => {
        await twilioHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Twilio does not support OAuth");
    });
  });
});
