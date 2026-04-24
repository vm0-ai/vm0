import { describe, it, expect } from "vitest";
import { browserUseHandler } from "../browser-use-handler";

describe("connector/providers/browser-use", () => {
  describe("buildAuthUrl", () => {
    it("throws because browser-use does not support OAuth", async () => {
      await expect(async () => {
        await browserUseHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Browser Use does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because browser-use does not support OAuth", async () => {
      await expect(async () => {
        await browserUseHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Browser Use does not support OAuth");
    });
  });
});
