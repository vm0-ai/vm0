import { describe, it, expect } from "vitest";
import { nyneHandler } from "@vm0/connectors/oauth-providers/providers/nyne-handler";

describe("connector/providers/nyne", () => {
  describe("buildAuthUrl", () => {
    it("throws because Nyne does not support OAuth", async () => {
      await expect(async () => {
        await nyneHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Nyne does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Nyne does not support OAuth", async () => {
      await expect(async () => {
        await nyneHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Nyne does not support OAuth");
    });
  });
});
