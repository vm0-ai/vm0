import { describe, it, expect } from "vitest";
import { ironcladHandler } from "@vm0/connectors/oauth-providers/providers/ironclad-handler";

describe("connector/providers/ironclad", () => {
  describe("buildAuthUrl", () => {
    it("throws because ironclad does not support OAuth", async () => {
      await expect(async () => {
        await ironcladHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Ironclad does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because ironclad does not support OAuth", async () => {
      await expect(async () => {
        await ironcladHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Ironclad does not support OAuth");
    });
  });
});
