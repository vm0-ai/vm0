import { describe, it, expect } from "vitest";
import { anthropicManagedAgentsHandler } from "../anthropic-managed-agents-handler";

describe("connector/providers/anthropic-managed-agents", () => {
  describe("buildAuthUrl", () => {
    it("throws because anthropic-managed-agents does not support OAuth", async () => {
      await expect(async () => {
        await anthropicManagedAgentsHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow(
        "Anthropic Managed Agents does not support OAuth",
      );
    });
  });

  describe("exchangeCode", () => {
    it("throws because anthropic-managed-agents does not support OAuth", async () => {
      await expect(async () => {
        await anthropicManagedAgentsHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow(
        "Anthropic Managed Agents does not support OAuth",
      );
    });
  });
});
