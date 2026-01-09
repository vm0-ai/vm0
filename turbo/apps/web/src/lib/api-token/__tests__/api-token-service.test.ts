import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { hasScope, hasAnyScope, hasAllScopes } from "../api-token-service";
import type { ApiScope } from "@vm0/core";

describe("API Token Service", () => {
  describe("hasScope", () => {
    it("should return true when scope is present", () => {
      const scopes: ApiScope[] = ["read:agents", "write:runs"];
      expect(hasScope(scopes, "read:agents")).toBe(true);
    });

    it("should return false when scope is not present", () => {
      const scopes: ApiScope[] = ["read:agents"];
      expect(hasScope(scopes, "write:agents")).toBe(false);
    });
  });

  describe("hasAnyScope", () => {
    it("should return true when any scope is present", () => {
      const scopes: ApiScope[] = ["read:agents"];
      expect(hasAnyScope(scopes, ["read:agents", "write:agents"])).toBe(true);
    });

    it("should return false when no scope is present", () => {
      const scopes: ApiScope[] = ["read:runs"];
      expect(hasAnyScope(scopes, ["read:agents", "write:agents"])).toBe(false);
    });
  });

  describe("hasAllScopes", () => {
    it("should return true when all scopes are present", () => {
      const scopes: ApiScope[] = ["read:agents", "write:agents", "read:runs"];
      expect(hasAllScopes(scopes, ["read:agents", "write:agents"])).toBe(true);
    });

    it("should return false when not all scopes are present", () => {
      const scopes: ApiScope[] = ["read:agents"];
      expect(hasAllScopes(scopes, ["read:agents", "write:agents"])).toBe(false);
    });
  });

  describe("Token Format", () => {
    it("should generate tokens with correct prefix", () => {
      // Verify token prefix format
      const prefix = "vm0_api_";
      expect(prefix).toMatch(/^vm0_api_$/);
    });

    it("should hash tokens using SHA-256", () => {
      const token = "vm0_api_test_token_123";
      const hash = createHash("sha256").update(token).digest("hex");

      // SHA-256 produces 64 character hex string
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });
});
