import { describe, it, expect } from "vitest";
import { togetherHandler } from "../together-handler";

describe("connector/providers/together", () => {
  describe("buildAuthUrl", () => {
    it("throws because Together AI does not support OAuth", async () => {
      await expect(async () => {
        await togetherHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow(
        "Together AI does not support OAuth — use API token auth",
      );
    });
  });

  describe("exchangeCode", () => {
    it("throws because Together AI does not support OAuth", async () => {
      await expect(async () => {
        await togetherHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow(
        "Together AI does not support OAuth — use API token auth",
      );
    });
  });

  describe("getSecretName", () => {
    it("returns TOGETHER_TOKEN", () => {
      expect(togetherHandler.getSecretName()).toBe("TOGETHER_TOKEN");
    });
  });
});
