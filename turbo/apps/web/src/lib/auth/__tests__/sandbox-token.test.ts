import { describe, it, expect } from "vitest";
import {
  generateSandboxToken,
  verifySandboxToken,
  isSandboxToken,
} from "../sandbox-token";

// Set required environment variables before any imports
process.env.SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("sandbox-token", () => {
  describe("generateSandboxToken", () => {
    it("should generate a valid JWT token", async () => {
      const token = await generateSandboxToken("user-123", "run-456");

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      // JWT format: header.payload.signature
      expect(token.split(".")).toHaveLength(3);
    });

    it("should generate different tokens for different runs", async () => {
      const token1 = await generateSandboxToken("user-123", "run-456");
      const token2 = await generateSandboxToken("user-123", "run-789");

      expect(token1).not.toBe(token2);
    });

    it("should generate different tokens for different users", async () => {
      const token1 = await generateSandboxToken("user-123", "run-456");
      const token2 = await generateSandboxToken("user-789", "run-456");

      expect(token1).not.toBe(token2);
    });
  });

  describe("verifySandboxToken", () => {
    it("should verify a valid token and return auth info", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      const auth = verifySandboxToken(token);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.runId).toBe("run-456");
    });

    it("should return null for invalid token format", () => {
      const auth = verifySandboxToken("not-a-jwt-token");

      expect(auth).toBeNull();
    });

    it("should return null for tampered token", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      // Tamper with the token by modifying the payload
      const parts = token.split(".");
      parts[1] = parts[1] + "tampered";
      const tamperedToken = parts.join(".");

      const auth = verifySandboxToken(tamperedToken);

      expect(auth).toBeNull();
    });

    it("should return null for token with invalid signature", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      // Replace signature with invalid one
      const parts = token.split(".");
      parts[2] = "invalid-signature";
      const invalidToken = parts.join(".");

      const auth = verifySandboxToken(invalidToken);

      expect(auth).toBeNull();
    });

    it("should return null for expired token", async () => {
      // Generate token with current time
      const token = await generateSandboxToken("user-123", "run-456");

      // Mock time to be 3 hours in the future (beyond 2 hour expiration)
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 3 * 60 * 60 * 1000;

      try {
        const auth = verifySandboxToken(token);
        expect(auth).toBeNull();
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should verify token that is still within expiration", async () => {
      const token = await generateSandboxToken("user-123", "run-456");

      // Mock time to be 1 hour in the future (within 2 hour expiration)
      const realDateNow = Date.now;
      Date.now = () => realDateNow() + 1 * 60 * 60 * 1000;

      try {
        const auth = verifySandboxToken(token);
        expect(auth).not.toBeNull();
        expect(auth?.userId).toBe("user-123");
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  describe("isSandboxToken", () => {
    it("should return true for JWT-like tokens", () => {
      expect(isSandboxToken("a.b.c")).toBe(true);
      expect(isSandboxToken("header.payload.signature")).toBe(true);
    });

    it("should return false for CLI tokens", () => {
      expect(isSandboxToken("vm0_live_abc123")).toBe(false);
    });

    it("should return false for random strings", () => {
      expect(isSandboxToken("not-a-token")).toBe(false);
      expect(isSandboxToken("only.two.parts.extra")).toBe(false);
      expect(isSandboxToken("")).toBe(false);
    });
  });

  describe("roundtrip", () => {
    it("should correctly roundtrip userId and runId", async () => {
      const testCases = [
        { userId: "user_123", runId: "run_456" },
        { userId: "user-with-dashes", runId: "run-with-dashes" },
        {
          userId: "very-long-user-id-that-is-quite-lengthy",
          runId: "very-long-run-id-that-is-quite-lengthy",
        },
      ];

      for (const { userId, runId } of testCases) {
        const token = await generateSandboxToken(userId, runId);
        const auth = verifySandboxToken(token);

        expect(auth).not.toBeNull();
        expect(auth?.userId).toBe(userId);
        expect(auth?.runId).toBe(runId);
      }
    });
  });
});
