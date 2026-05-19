import { describe, it, expect } from "vitest";
import { mathpixHandler } from "@vm0/connectors/oauth-providers/providers/mathpix-handler";

describe("connector/providers/mathpix", () => {
  describe("buildAuthUrl", () => {
    it("throws because Mathpix does not support OAuth", async () => {
      await expect(async () => {
        await mathpixHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Mathpix does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Mathpix does not support OAuth", async () => {
      await expect(async () => {
        await mathpixHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Mathpix does not support OAuth");
    });
  });
});
