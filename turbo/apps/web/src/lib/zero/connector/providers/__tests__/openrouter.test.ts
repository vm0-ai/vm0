import { describe, it, expect } from "vitest";
import { openrouterHandler } from "@vm0/connectors/oauth-providers/providers/openrouter-handler";

describe("connector/providers/openrouter", () => {
  describe("buildAuthUrl", () => {
    it("throws because OpenRouter does not support OAuth", async () => {
      await expect(async () => {
        await openrouterHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("OpenRouter does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because OpenRouter does not support OAuth", async () => {
      await expect(async () => {
        await openrouterHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("OpenRouter does not support OAuth");
    });
  });
});
