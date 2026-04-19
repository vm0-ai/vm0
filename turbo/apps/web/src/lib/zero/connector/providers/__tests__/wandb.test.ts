import { describe, it, expect } from "vitest";
import { wandbHandler } from "../wandb-handler";

describe("connector/providers/wandb", () => {
  describe("buildAuthUrl", () => {
    it("throws because wandb does not support OAuth", async () => {
      await expect(async () => {
        await wandbHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Weights & Biases does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because wandb does not support OAuth", async () => {
      await expect(async () => {
        await wandbHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Weights & Biases does not support OAuth");
    });
  });
});
