import { describe, it, expect } from "vitest";
import { exaHandler } from "../exa-handler";

describe("connector/providers/exa", () => {
  describe("buildAuthUrl", () => {
    it("throws because exa does not support OAuth", async () => {
      await expect(async () => {
        await exaHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Exa does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because exa does not support OAuth", async () => {
      await expect(async () => {
        await exaHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Exa does not support OAuth");
    });
  });

  describe("getSecretName", () => {
    it("returns EXA_TOKEN", () => {
      expect(exaHandler.getSecretName()).toBe("EXA_TOKEN");
    });
  });
});
