import { describe, it, expect } from "vitest";
import { bufferHandler } from "@vm0/connectors/oauth-providers/providers/buffer-handler";

describe("connector/providers/buffer", () => {
  describe("buildAuthUrl", () => {
    it("throws because buffer does not support OAuth", async () => {
      await expect(async () => {
        await bufferHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Buffer does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because buffer does not support OAuth", async () => {
      await expect(async () => {
        await bufferHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Buffer does not support OAuth");
    });
  });
});
