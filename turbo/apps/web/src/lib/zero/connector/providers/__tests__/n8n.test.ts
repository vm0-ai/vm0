import { describe, it, expect } from "vitest";
import { n8nHandler } from "@vm0/connectors/oauth-providers/providers/n8n-handler";

describe("connector/providers/n8n", () => {
  describe("buildAuthUrl", () => {
    it("throws because n8n does not support OAuth", async () => {
      await expect(async () => {
        await n8nHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("n8n does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because n8n does not support OAuth", async () => {
      await expect(async () => {
        await n8nHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("n8n does not support OAuth");
    });
  });
});
