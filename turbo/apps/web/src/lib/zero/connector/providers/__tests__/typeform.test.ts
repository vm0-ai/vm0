import { describe, it, expect } from "vitest";
import { typeformHandler } from "@vm0/connectors/oauth-providers/providers/typeform-handler";

describe("connector/providers/typeform", () => {
  describe("buildAuthUrl", () => {
    it("throws because typeform does not support OAuth", async () => {
      await expect(async () => {
        await typeformHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Typeform does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because typeform does not support OAuth", async () => {
      await expect(async () => {
        await typeformHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Typeform does not support OAuth");
    });
  });
});
