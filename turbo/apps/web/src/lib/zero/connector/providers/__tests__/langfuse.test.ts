import { describe, it, expect } from "vitest";
import { langfuseHandler } from "../langfuse-handler";

describe("connector/providers/langfuse", () => {
  describe("buildAuthUrl", () => {
    it("throws because langfuse does not support OAuth", async () => {
      await expect(async () => {
        await langfuseHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Langfuse does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because langfuse does not support OAuth", async () => {
      await expect(async () => {
        await langfuseHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Langfuse does not support OAuth");
    });
  });
});
