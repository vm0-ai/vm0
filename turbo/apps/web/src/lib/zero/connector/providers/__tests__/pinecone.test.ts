import { describe, it, expect } from "vitest";
import { pineconeHandler } from "@vm0/connectors/oauth-providers/providers/pinecone-handler";

describe("connector/providers/pinecone", () => {
  describe("buildAuthUrl", () => {
    it("throws because pinecone does not support OAuth", async () => {
      await expect(async () => {
        await pineconeHandler.buildAuthUrl(
          "client-id",
          "https://example.com",
          "state",
        );
      }).rejects.toThrow("Pinecone does not support OAuth");
    });
  });

  describe("exchangeCode", () => {
    it("throws because pinecone does not support OAuth", async () => {
      await expect(async () => {
        await pineconeHandler.exchangeCode(
          "client-id",
          "client-secret",
          "code",
          "https://example.com",
        );
      }).rejects.toThrow("Pinecone does not support OAuth");
    });
  });
});
