import { describe, it, expect } from "vitest";
import { freshdeskHandler } from "../freshdesk-handler";

describe("connector/providers/freshdesk", () => {
  describe("buildAuthUrl", () => {
    it("throws because freshdesk does not support OAuth", async () => {
      await expect(async () => {
        await freshdeskHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Freshdesk does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because freshdesk does not support OAuth", async () => {
      await expect(async () => {
        await freshdeskHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Freshdesk does not support OAuth");
    });
  });
});
