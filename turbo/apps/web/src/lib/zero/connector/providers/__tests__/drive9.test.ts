import { describe, it, expect } from "vitest";
import { drive9Handler } from "../drive9-handler";

describe("connector/providers/drive9", () => {
  describe("buildAuthUrl", () => {
    it("throws because drive9 does not support OAuth", async () => {
      await expect(async () => {
        await drive9Handler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("drive9 does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because drive9 does not support OAuth", async () => {
      await expect(async () => {
        await drive9Handler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("drive9 does not support OAuth");
    });
  });
});
