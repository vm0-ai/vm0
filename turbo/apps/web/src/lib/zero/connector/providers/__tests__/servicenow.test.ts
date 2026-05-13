import { describe, it, expect } from "vitest";
import { servicenowHandler } from "@vm0/connectors/oauth-providers/providers/servicenow-handler";

describe("connector/providers/servicenow", () => {
  describe("buildAuthUrl", () => {
    it("throws because servicenow does not support OAuth", async () => {
      await expect(async () => {
        await servicenowHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("ServiceNow does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because servicenow does not support OAuth", async () => {
      await expect(async () => {
        await servicenowHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("ServiceNow does not support OAuth");
    });
  });
});
