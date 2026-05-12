import { describe, it, expect } from "vitest";
import { codaHandler } from "@vm0/connectors/oauth-providers/providers/coda-handler";

describe("connector/providers/coda", () => {
  describe("buildAuthUrl", () => {
    it("throws because coda does not support OAuth", async () => {
      await expect(async () => {
        await codaHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Coda does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because coda does not support OAuth", async () => {
      await expect(async () => {
        await codaHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Coda does not support OAuth");
    });
  });
});
