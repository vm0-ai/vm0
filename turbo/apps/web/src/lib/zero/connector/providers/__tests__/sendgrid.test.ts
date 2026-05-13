import { describe, it, expect } from "vitest";
import { sendgridHandler } from "@vm0/connectors/oauth-providers/providers/sendgrid-handler";

describe("connector/providers/sendgrid", () => {
  describe("buildAuthUrl", () => {
    it("throws because sendgrid does not support OAuth", async () => {
      await expect(async () => {
        await sendgridHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("SendGrid does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because sendgrid does not support OAuth", async () => {
      await expect(async () => {
        await sendgridHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("SendGrid does not support OAuth");
    });
  });
});
