import { describe, it, expect } from "vitest";
import { generateWebhookToken, validateWebhookToken } from "../webhook-auth";
import { NextRequest } from "next/server";
import { UnauthorizedError } from "../errors";

describe("Webhook Authentication", () => {
  describe("generateWebhookToken", () => {
    it("should generate token with runtime ID", () => {
      const runtimeId = "rt-test-123";
      const token = generateWebhookToken(runtimeId);

      expect(token).toMatch(/^rt-rt-test-123-[a-z0-9]+$/);
    });

    it("should generate unique tokens", () => {
      const runtimeId = "rt-test-123";
      const token1 = generateWebhookToken(runtimeId);
      const token2 = generateWebhookToken(runtimeId);

      expect(token1).not.toBe(token2);
    });

    it("should generate tokens with sufficient length", () => {
      const runtimeId = "rt-test-123";
      const token = generateWebhookToken(runtimeId);

      // Token should be at least 20 characters (prefix + random part)
      expect(token.length).toBeGreaterThan(20);
    });
  });

  describe("validateWebhookToken", () => {
    it("should accept valid token", async () => {
      const runtimeId = "test-runtime-123";
      const token = generateWebhookToken(runtimeId);

      const request = new NextRequest("http://localhost/test", {
        headers: {
          "x-vm0-token": token,
        },
      });

      await expect(
        validateWebhookToken(request, runtimeId),
      ).resolves.toBeUndefined();
    });

    it("should reject missing token", async () => {
      const runtimeId = "test-runtime-123";

      const request = new NextRequest("http://localhost/test", {
        headers: {},
      });

      await expect(validateWebhookToken(request, runtimeId)).rejects.toThrow(
        UnauthorizedError,
      );
      await expect(validateWebhookToken(request, runtimeId)).rejects.toThrow(
        "Missing webhook token",
      );
    });

    it("should reject token with wrong runtime ID", async () => {
      const runtimeId1 = "test-runtime-123";
      const runtimeId2 = "test-runtime-456";
      const token = generateWebhookToken(runtimeId1);

      const request = new NextRequest("http://localhost/test", {
        headers: {
          "x-vm0-token": token,
        },
      });

      await expect(validateWebhookToken(request, runtimeId2)).rejects.toThrow(
        UnauthorizedError,
      );
      await expect(validateWebhookToken(request, runtimeId2)).rejects.toThrow(
        "Invalid webhook token",
      );
    });

    it("should reject invalid token format", async () => {
      const runtimeId = "test-runtime-123";

      const request = new NextRequest("http://localhost/test", {
        headers: {
          "x-vm0-token": "invalid-token",
        },
      });

      await expect(validateWebhookToken(request, runtimeId)).rejects.toThrow(
        UnauthorizedError,
      );
      await expect(validateWebhookToken(request, runtimeId)).rejects.toThrow(
        "Invalid webhook token",
      );
    });
  });
});
