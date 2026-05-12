import { describe, it, expect } from "vitest";
import { miroHandler } from "@vm0/connectors/oauth-providers/providers/miro-handler";

describe("connector/providers/miro", () => {
  describe("buildAuthUrl", () => {
    it("throws because miro does not support OAuth", async () => {
      await expect(async () => {
        await miroHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Miro does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because miro does not support OAuth", async () => {
      await expect(async () => {
        await miroHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Miro does not support OAuth");
    });
  });
});
