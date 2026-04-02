import { describe, it, expect } from "vitest";
import { apolloHandler } from "../apollo-handler";

describe("connector/providers/apollo", () => {
  describe("getSecretName", () => {
    it("returns APOLLO_TOKEN", () => {
      expect(apolloHandler.getSecretName()).toBe("APOLLO_TOKEN");
    });
  });

  describe("getClientId", () => {
    it("returns undefined — apollo uses api-token auth only", () => {
      expect(
        apolloHandler.getClientId(
          {} as Parameters<typeof apolloHandler.getClientId>[0],
        ),
      ).toBeUndefined();
    });
  });

  describe("getClientSecret", () => {
    it("returns undefined — apollo uses api-token auth only", () => {
      expect(
        apolloHandler.getClientSecret(
          {} as Parameters<typeof apolloHandler.getClientSecret>[0],
        ),
      ).toBeUndefined();
    });
  });

  describe("buildAuthUrl", () => {
    it("throws because apollo does not support OAuth", async () => {
      await expect(
        Promise.resolve().then(() => {
          return apolloHandler.buildAuthUrl(
            "client-id",
            "https://example.com",
            "state",
          );
        }),
      ).rejects.toThrow("Apollo does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because apollo does not support OAuth", async () => {
      await expect(
        Promise.resolve().then(() => {
          return apolloHandler.exchangeCode(
            "client-id",
            "client-secret",
            "code",
            "https://example.com",
          );
        }),
      ).rejects.toThrow("Apollo does not support OAuth");
    });
  });
});
