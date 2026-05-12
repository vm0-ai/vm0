import { describe, it, expect } from "vitest";
import { lumaAiHandler } from "@vm0/connectors/oauth-providers/providers/luma-ai-handler";

describe("connector/providers/luma-ai", () => {
  describe("buildAuthUrl", () => {
    it("throws because luma-ai does not support OAuth", async () => {
      await expect(async () => {
        await lumaAiHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Luma AI does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because luma-ai does not support OAuth", async () => {
      await expect(async () => {
        await lumaAiHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Luma AI does not support OAuth");
    });
  });
});
