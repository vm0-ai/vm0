import { describe, it, expect } from "vitest";
import { manusHandler } from "@vm0/connectors/oauth-providers/providers/manus-handler";

describe("connector/providers/manus", () => {
  describe("buildAuthUrl", () => {
    it("throws because manus does not support OAuth", async () => {
      await expect(async () => {
        await manusHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Manus does not support OAuth — use API key auth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because manus does not support OAuth", async () => {
      await expect(async () => {
        await manusHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Manus does not support OAuth — use API key auth");
    });
  });

  describe("getSecretName", () => {
    it("returns MANUS_TOKEN", () => {
      expect(manusHandler.getSecretName()).toBe("MANUS_TOKEN");
    });
  });
});
