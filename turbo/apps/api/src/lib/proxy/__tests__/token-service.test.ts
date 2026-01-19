import { describe, it, expect } from "vitest";
import {
  createProxyToken,
  decryptProxyToken,
  isProxyToken,
  extractSecretFromToken,
  PROXY_TOKEN_PREFIX,
} from "../token-service";

describe("Token Service", () => {
  const testRunId = "run-123";
  const testUserId = "user-456";
  const testSecretName = "ANTHROPIC_API_KEY";
  const testSecretValue = "sk-ant-test-secret-key";

  describe("createProxyToken", () => {
    it("should create a token with correct prefix", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      expect(token.startsWith(PROXY_TOKEN_PREFIX)).toBe(true);
    });

    it("should create different tokens for same input (due to random IV)", () => {
      const token1 = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );
      const token2 = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      expect(token1).not.toBe(token2);
    });
  });

  describe("decryptProxyToken", () => {
    it("should decrypt a valid token", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const result = decryptProxyToken(token);

      expect(result.valid).toBe(true);
      expect(result.payload?.runId).toBe(testRunId);
      expect(result.payload?.userId).toBe(testUserId);
      expect(result.payload?.secretName).toBe(testSecretName);
      expect(result.payload?.secretValue).toBe(testSecretValue);
    });

    it("should work with or without prefix", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );
      const tokenWithoutPrefix = token.slice(PROXY_TOKEN_PREFIX.length);

      const result1 = decryptProxyToken(token);
      const result2 = decryptProxyToken(tokenWithoutPrefix);

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
      expect(result1.payload?.secretValue).toBe(result2.payload?.secretValue);
    });

    it("should reject expired tokens", () => {
      // Create token that expires in -1 second (already expired)
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
        -1000,
      );

      const result = decryptProxyToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Token expired");
    });

    it("should reject invalid run ID when expectedRunId is provided", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const result = decryptProxyToken(token, "different-run-id");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Run ID mismatch");
    });

    it("should accept matching run ID when expectedRunId is provided", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const result = decryptProxyToken(token, testRunId);

      expect(result.valid).toBe(true);
    });

    it("should reject tampered tokens", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      // Tamper with the base64 payload
      const tampered =
        PROXY_TOKEN_PREFIX +
        token.slice(PROXY_TOKEN_PREFIX.length + 5) +
        "xxxx";

      const result = decryptProxyToken(tampered);

      expect(result.valid).toBe(false);
    });

    it("should reject completely invalid tokens", () => {
      const result = decryptProxyToken("not-a-valid-token");

      expect(result.valid).toBe(false);
      // Short tokens return "Token too short", malformed base64 returns "Invalid token"
      expect(["Token too short", "Invalid token"]).toContain(result.error);
    });

    it("should reject tokens that are too short", () => {
      const result = decryptProxyToken(PROXY_TOKEN_PREFIX + "abc");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Token too short");
    });
  });

  describe("isProxyToken", () => {
    it("should return true for proxy tokens", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      expect(isProxyToken(token)).toBe(true);
    });

    it("should return false for regular API keys", () => {
      expect(isProxyToken("sk-ant-api03-xxxx")).toBe(false);
      expect(isProxyToken("Bearer token")).toBe(false);
      expect(isProxyToken("vm0_live_xxx")).toBe(false);
    });

    it("should return true for tokens with prefix only", () => {
      expect(isProxyToken(PROXY_TOKEN_PREFIX + "anything")).toBe(true);
    });
  });

  describe("extractSecretFromToken", () => {
    it("should extract secret from valid token", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const secret = extractSecretFromToken(token);

      expect(secret).toBe(testSecretValue);
    });

    it("should return null for invalid token", () => {
      const secret = extractSecretFromToken("invalid-token");

      expect(secret).toBeNull();
    });

    it("should return null for expired token", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
        -1000,
      );

      const secret = extractSecretFromToken(token);

      expect(secret).toBeNull();
    });

    it("should return null when run ID doesn't match", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const secret = extractSecretFromToken(token, "wrong-run-id");

      expect(secret).toBeNull();
    });
  });

  describe("Token Expiration", () => {
    it("should create token with custom expiration", () => {
      // Create token that expires in 1 hour
      const oneHourMs = 60 * 60 * 1000;
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
        oneHourMs,
      );

      const result = decryptProxyToken(token);

      expect(result.valid).toBe(true);
      // Check expiration is roughly 1 hour from now
      const expiresAt = result.payload?.expiresAt ?? 0;
      const expectedExpiry = Date.now() + oneHourMs;
      expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(1000);
    });

    it("should use default 2 hour expiration", () => {
      const token = createProxyToken(
        testRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const result = decryptProxyToken(token);

      expect(result.valid).toBe(true);
      const expiresAt = result.payload?.expiresAt ?? 0;
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const expectedExpiry = Date.now() + twoHoursMs;
      expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(1000);
    });
  });
});
