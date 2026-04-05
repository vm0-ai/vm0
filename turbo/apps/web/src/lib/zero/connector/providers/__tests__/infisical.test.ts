import { describe, it, expect } from "vitest";
import { infisicalHandler } from "../infisical-handler";

describe("connector/providers/infisical", () => {
  describe("buildAuthUrl", () => {
    it("throws because infisical does not support OAuth", async () => {
      await expect(async () => {
        await infisicalHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Infisical does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because infisical does not support OAuth", async () => {
      await expect(async () => {
        await infisicalHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Infisical does not support OAuth");
    });
  });
});