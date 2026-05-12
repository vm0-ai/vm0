import { describe, it, expect } from "vitest";
import { amplitudeHandler } from "@vm0/connectors/oauth-providers/providers/amplitude-handler";

describe("connector/providers/amplitude", () => {
  describe("buildAuthUrl", () => {
    it("throws because amplitude does not support OAuth", async () => {
      await expect(async () => {
        await amplitudeHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Amplitude does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because amplitude does not support OAuth", async () => {
      await expect(async () => {
        await amplitudeHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Amplitude does not support OAuth");
    });
  });
});
