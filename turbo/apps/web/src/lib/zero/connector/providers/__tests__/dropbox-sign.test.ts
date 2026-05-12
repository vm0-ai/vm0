import { describe, it, expect } from "vitest";
import { dropboxSignHandler } from "@vm0/connectors/oauth-providers/providers/dropbox-sign-handler";

describe("connector/providers/dropbox-sign", () => {
  describe("buildAuthUrl", () => {
    it("throws because dropbox-sign does not support OAuth", async () => {
      await expect(async () => {
        await dropboxSignHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Dropbox Sign does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because dropbox-sign does not support OAuth", async () => {
      await expect(async () => {
        await dropboxSignHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Dropbox Sign does not support OAuth");
    });
  });
});
