import { describe, it, expect } from "vitest";
import { onyxHandler } from "../onyx-handler";

describe("connector/providers/onyx", () => {
  describe("buildAuthUrl", () => {
    it("throws because onyx does not support OAuth", async () => {
      await expect(async () => {
        await onyxHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Onyx does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because onyx does not support OAuth", async () => {
      await expect(async () => {
        await onyxHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Onyx does not support OAuth");
    });
  });
});
