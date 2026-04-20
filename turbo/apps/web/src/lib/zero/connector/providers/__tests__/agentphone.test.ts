import { describe, it, expect } from "vitest";
import { agentphoneHandler } from "../agentphone-handler";

describe("connector/providers/agentphone", () => {
  describe("buildAuthUrl", () => {
    it("throws because agentphone does not support OAuth", async () => {
      await expect(async () => {
        await agentphoneHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("AgentPhone does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because agentphone does not support OAuth", async () => {
      await expect(async () => {
        await agentphoneHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("AgentPhone does not support OAuth");
    });
  });
});
