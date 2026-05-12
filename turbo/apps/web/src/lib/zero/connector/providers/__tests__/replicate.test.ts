import { describe, it, expect } from "vitest";
import { replicateHandler } from "@vm0/connectors/oauth-providers/providers/replicate-handler";

describe("connector/providers/replicate", () => {
  describe("buildAuthUrl", () => {
    it("throws because Replicate does not support OAuth", async () => {
      await expect(async () => {
        await replicateHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Replicate does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because Replicate does not support OAuth", async () => {
      await expect(async () => {
        await replicateHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Replicate does not support OAuth");
    });
  });
});
