import { describe, it, expect } from "vitest";
import { postalformHandler } from "@vm0/connectors/oauth-providers/providers/postalform-handler";

describe("connector/providers/postalform", () => {
  describe("buildAuthUrl", () => {
    it("throws because PostalForm does not support OAuth", async () => {
      await expect(async () => {
        await postalformHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("PostalForm does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because PostalForm does not support OAuth", async () => {
      await expect(async () => {
        await postalformHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("PostalForm does not support OAuth");
    });
  });
});
