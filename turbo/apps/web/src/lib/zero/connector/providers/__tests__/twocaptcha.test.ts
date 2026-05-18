import { describe, it, expect } from "vitest";
import { twocaptchaHandler } from "@vm0/connectors/oauth-providers/providers/twocaptcha-handler";

describe("connector/providers/twocaptcha", () => {
  describe("buildAuthUrl", () => {
    it("throws because 2Captcha does not support OAuth", async () => {
      await expect(async () => {
        await twocaptchaHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("2Captcha does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because 2Captcha does not support OAuth", async () => {
      await expect(async () => {
        await twocaptchaHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("2Captcha does not support OAuth");
    });
  });
});
