import { describe, it, expect } from "vitest";
import { e2bHandler } from "../e2b-handler";

describe("connector/providers/e2b", () => {
  describe("buildAuthUrl", () => {
    it("throws because E2B does not support OAuth", async () => {
      await expect(async () => {
        await e2bHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("E2B does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because E2B does not support OAuth", async () => {
      await expect(async () => {
        await e2bHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("E2B does not support OAuth");
    });
  });
});
