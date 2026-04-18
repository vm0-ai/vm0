import { describe, it, expect } from "vitest";
import { greenhouseHandler } from "../greenhouse-handler";

describe("connector/providers/greenhouse", () => {
  describe("buildAuthUrl", () => {
    it("throws because greenhouse does not support OAuth", async () => {
      await expect(async () => {
        await greenhouseHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Greenhouse does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because greenhouse does not support OAuth", async () => {
      await expect(async () => {
        await greenhouseHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Greenhouse does not support OAuth");
    });
  });
});
