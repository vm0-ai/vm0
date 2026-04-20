import { describe, it, expect } from "vitest";
import { groqHandler } from "../groq-handler";

describe("connector/providers/groq", () => {
  describe("buildAuthUrl", () => {
    it("throws because groq does not support OAuth", async () => {
      await expect(async () => {
        await groqHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Groq does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because groq does not support OAuth", async () => {
      await expect(async () => {
        await groqHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Groq does not support OAuth");
    });
  });
});
