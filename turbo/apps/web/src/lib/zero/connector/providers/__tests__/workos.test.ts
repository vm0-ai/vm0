import { describe, it, expect } from "vitest";
import { workosHandler } from "../workos-handler";

describe("connector/providers/workos", () => {
  describe("buildAuthUrl", () => {
    it("throws because WorkOS does not support OAuth", async () => {
      await expect(async () => {
        await workosHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("WorkOS does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because WorkOS does not support OAuth", async () => {
      await expect(async () => {
        await workosHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("WorkOS does not support OAuth");
    });
  });
});
