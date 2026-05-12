import { describe, it, expect } from "vitest";
import { db9Handler } from "@vm0/connectors/oauth-providers/providers/db9-handler";

describe("connector/providers/db9", () => {
  describe("buildAuthUrl", () => {
    it("throws because db9 does not support OAuth", async () => {
      await expect(async () => {
        await db9Handler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("db9 does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because db9 does not support OAuth", async () => {
      await expect(async () => {
        await db9Handler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("db9 does not support OAuth");
    });
  });
});
