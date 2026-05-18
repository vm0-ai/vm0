import { describe, it, expect } from "vitest";
import { flightapiHandler } from "@vm0/connectors/oauth-providers/providers/flightapi-handler";

describe("connector/providers/flightapi", () => {
  describe("buildAuthUrl", () => {
    it("throws because FlightAPI does not support OAuth", async () => {
      await expect(async () => {
        await flightapiHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("FlightAPI does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because FlightAPI does not support OAuth", async () => {
      await expect(async () => {
        await flightapiHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("FlightAPI does not support OAuth");
    });
  });
});
