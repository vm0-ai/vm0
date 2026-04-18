import { describe, it, expect } from "vitest";
import { attioHandler } from "../attio-handler";

describe("connector/providers/attio", () => {
  describe("buildAuthUrl", () => {
    it("throws because attio does not support OAuth", async () => {
      await expect(async () => {
        await attioHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Attio does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because attio does not support OAuth", async () => {
      await expect(async () => {
        await attioHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Attio does not support OAuth");
    });
  });
});
