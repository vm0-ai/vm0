import { describe, it, expect } from "vitest";
import { pipedriveHandler } from "@vm0/connectors/oauth-providers/providers/pipedrive-handler";

describe("connector/providers/pipedrive", () => {
  describe("buildAuthUrl", () => {
    it("throws because pipedrive does not support OAuth", async () => {
      await expect(async () => {
        await pipedriveHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Pipedrive does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because pipedrive does not support OAuth", async () => {
      await expect(async () => {
        await pipedriveHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Pipedrive does not support OAuth");
    });
  });
});
