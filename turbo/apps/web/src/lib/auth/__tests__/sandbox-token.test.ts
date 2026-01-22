import { describe, it, expect } from "vitest";
import { TOKEN_PREFIXES } from "@vm0/core";
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
    it("should generate a token with vm0_sandbox_ prefix", async () => {
      const token = await generateSandboxToken("user-123", "run-456");

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      // Token format: vm0_sandbox_<jwt>
      expect(token.startsWith(TOKEN_PREFIXES.SANDBOX)).toBe(true);
      // JWT part should have 3 parts
      const jwtPart = token.slice(TOKEN_PREFIXES.SANDBOX.length);
      expect(jwtPart.split(".")).toHaveLength(3);
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
      // Tamper with the token by modifying the JWT payload part
      const jwtPart = token.slice(TOKEN_PREFIXES.SANDBOX.length);
      const parts = jwtPart.split(".");
      parts[1] = parts[1] + "tampered";
      const tamperedToken = TOKEN_PREFIXES.SANDBOX + parts.join(".");

      const auth = verifySandboxToken(tamperedToken);

      expect(auth).toBeNull();
    });

    it("should return null for token with invalid signature", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      // Replace signature with invalid one
      const jwtPart = token.slice(TOKEN_PREFIXES.SANDBOX.length);
      const parts = jwtPart.split(".");
      parts[2] = "invalid-signature";
      const invalidToken = TOKEN_PREFIXES.SANDBOX + parts.join(".");

      const auth = verifySandboxToken(invalidToken);

      expect(auth).toBeNull();
    });

    it("should return null for token without prefix", async () => {
      const token = await generateSandboxToken("user-123", "run-456");
      // Remove the prefix
      const jwtPart = token.slice(TOKEN_PREFIXES.SANDBOX.length);

      const auth = verifySandboxToken(jwtPart);

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
    it("should return true for tokens with vm0_sandbox_ prefix", async () => {
      const token = await generateSandboxToken("user_123", "run_456");
      expect(isSandboxToken(token)).toBe(true);
    });

    it("should return true for any string with vm0_sandbox_ prefix", () => {
      expect(isSandboxToken("vm0_sandbox_anything")).toBe(true);
      expect(isSandboxToken("vm0_sandbox_")).toBe(true);
    });

    it("should return false for Clerk JWT tokens", () => {
      const clerkPayload = { sub: "user_123", iat: 123, exp: 456 };
      const fakeClerkToken = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(clerkPayload)).toString("base64url")}.signature`;
      expect(isSandboxToken(fakeClerkToken)).toBe(false);
    });

    it("should return false for CLI tokens", () => {
      expect(isSandboxToken("vm0_live_abc123")).toBe(false);
    });

    it("should return false for random strings", () => {
      expect(isSandboxToken("not-a-token")).toBe(false);
      expect(isSandboxToken("vm0_sandbo")).toBe(false); // Almost but not quite
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
