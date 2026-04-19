import { describe, it, expect } from "vitest";
import { stabilityAiHandler } from "../stability-ai-handler";

describe("connector/providers/stability-ai", () => {
  describe("buildAuthUrl", () => {
    it("throws because Stability AI does not support OAuth", async () => {
      await expect(async () => {
        await stabilityAiHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow(
        "Stability AI does not support OAuth — use API token auth",
      );
    });
  });

  describe("exchangeCode", () => {
    it("throws because Stability AI does not support OAuth", async () => {
      await expect(async () => {
        await stabilityAiHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow(
        "Stability AI does not support OAuth — use API token auth",
      );
    });
  });
});
