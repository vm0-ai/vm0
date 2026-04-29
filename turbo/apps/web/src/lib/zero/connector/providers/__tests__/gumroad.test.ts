import { describe, it, expect } from "vitest";
import { gumroadHandler } from "../gumroad-handler";

describe("connector/providers/gumroad", () => {
  describe("buildAuthUrl", () => {
    it("throws because gumroad does not support OAuth", async () => {
      await expect(async () => {
        await gumroadHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Gumroad does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because gumroad does not support OAuth", async () => {
      await expect(async () => {
        await gumroadHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Gumroad does not support OAuth");
    });
  });
});
