import { describe, it, expect } from "vitest";
import { langsmithHandler } from "../langsmith-handler";

describe("connector/providers/langsmith", () => {
  describe("buildAuthUrl", () => {
    it("throws because langsmith does not support OAuth", async () => {
      await expect(async () => {
        await langsmithHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("LangSmith does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because langsmith does not support OAuth", async () => {
      await expect(async () => {
        await langsmithHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("LangSmith does not support OAuth");
    });
  });
});
