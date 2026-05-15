import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import {
  generateSandboxToken,
  verifySandboxToken,
  isSandboxToken,
  isPatToken,
  generateComposeJobToken,
  verifyComposeJobToken,
  generateZeroToken,
  verifyZeroToken,
  generateCliToken,
  verifyCliToken,
  SANDBOX_TOKEN_PREFIX,
  PAT_TOKEN_PREFIX,
  signSandboxJwtForTests,
} from "../sandbox-token";

// SECRETS_ENCRYPTION_KEY is set in setup.ts

// Mock isFeatureEnabled from @vm0/core/feature-switch for conditional capability tests
const mockIsFeatureEnabled = vi.fn();
vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: (...args: unknown[]) => {
      return mockIsFeatureEnabled(...args) as boolean;
    },
  };
});

describe("sandbox-token", () => {
  describe("generateSandboxToken", () => {
    it("should generate a prefixed token", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.startsWith(SANDBOX_TOKEN_PREFIX)).toBe(true);
      // JWT portion after prefix should have 3 dot-separated parts
      const jwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("should generate different tokens for different runs", async () => {
      const token1 = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const token2 = await generateSandboxToken(
        "user-123",
        "run-789",
        "org-test",
      );

      expect(token1).not.toBe(token2);
    });

    it("should generate different tokens for different users", async () => {
      const token1 = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const token2 = await generateSandboxToken(
        "user-789",
        "run-456",
        "org-test",
      );

      expect(token1).not.toBe(token2);
    });
  });

  describe("verifySandboxToken", () => {
    it("should verify a valid token and return auth info", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const auth = verifySandboxToken(token);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.runId).toBe("run-456");
      expect(auth?.orgId).toBe("org-test");
    });

    it("should return null for token without prefix", () => {
      const auth = verifySandboxToken("not-a-jwt-token");

      expect(auth).toBeNull();
    });

    it("should return null for raw JWT without prefix", () => {
      // A raw JWT (3 dot-separated parts) should be rejected without prefix
      const auth = verifySandboxToken("header.payload.signature");

      expect(auth).toBeNull();
    });

    it("should return null for tampered token", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      // Tamper with the JWT portion after the prefix
      const jwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
      const parts = jwt.split(".");
      parts[1] = parts[1] + "tampered";
      const tamperedToken = SANDBOX_TOKEN_PREFIX + parts.join(".");

      const auth = verifySandboxToken(tamperedToken);

      expect(auth).toBeNull();
    });

    it("should return null for token with invalid signature", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const jwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
      const parts = jwt.split(".");
      parts[2] = "invalid-signature";
      const invalidToken = SANDBOX_TOKEN_PREFIX + parts.join(".");

      const auth = verifySandboxToken(invalidToken);

      expect(auth).toBeNull();
    });

    it("should return null for legacy token without orgId", () => {
      // Sign a sandbox payload shaped like the pre-orgId format.
      // `generateSandboxToken` now requires `orgId`, so this scenario is
      // otherwise unreachable — we sign the JWT directly to pin the
      // verifier's fail-closed contract for tokens minted before this
      // deploy.
      const now = Math.floor(Date.now() / 1000);
      const legacyToken = signSandboxJwtForTests({
        userId: "user-123",
        runId: "run-456",
        scope: "sandbox",
        iat: now,
        exp: now + 3600,
      });

      expect(verifySandboxToken(legacyToken)).toBeNull();
    });

    it("should return null for token with empty orgId", () => {
      const now = Math.floor(Date.now() / 1000);
      const tokenWithEmptyOrg = signSandboxJwtForTests({
        userId: "user-123",
        runId: "run-456",
        orgId: "",
        scope: "sandbox",
        iat: now,
        exp: now + 3600,
      });

      expect(verifySandboxToken(tokenWithEmptyOrg)).toBeNull();
    });

    it("should return null for expired token", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );

      // Mock time to be 3 hours in the future (beyond 2 hour expiration)
      const realDateNow = Date.now;
      Date.now = () => {
        return realDateNow() + 3 * 60 * 60 * 1000;
      };

      try {
        const auth = verifySandboxToken(token);
        expect(auth).toBeNull();
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should verify token that is still within expiration", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );

      // Mock time to be 1 hour in the future (within 2 hour expiration)
      const realDateNow = Date.now;
      Date.now = () => {
        return realDateNow() + 1 * 60 * 60 * 1000;
      };

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
    it("should return true for tokens with sandbox prefix", () => {
      expect(isSandboxToken("vm0_sandbox_header.payload.signature")).toBe(true);
      expect(isSandboxToken("vm0_sandbox_anything")).toBe(true);
    });

    it("should return false for raw JWTs without prefix", () => {
      expect(isSandboxToken("a.b.c")).toBe(false);
      expect(isSandboxToken("header.payload.signature")).toBe(false);
    });

    it("should return false for random strings", () => {
      expect(isSandboxToken("not-a-token")).toBe(false);
      expect(isSandboxToken("")).toBe(false);
    });
  });

  describe("roundtrip", () => {
    it("should correctly roundtrip userId, runId and orgId", async () => {
      const testCases = [
        { userId: "user_123", runId: "run_456", orgId: "org_abc" },
        {
          userId: "user-with-dashes",
          runId: "run-with-dashes",
          orgId: "org-with-dashes",
        },
        {
          userId: "very-long-user-id-that-is-quite-lengthy",
          runId: "very-long-run-id-that-is-quite-lengthy",
          orgId: "very-long-org-id-that-is-quite-lengthy",
        },
      ];

      for (const { userId, runId, orgId } of testCases) {
        const token = await generateSandboxToken(userId, runId, orgId);
        const auth = verifySandboxToken(token);

        expect(auth).not.toBeNull();
        expect(auth?.userId).toBe(userId);
        expect(auth?.runId).toBe(runId);
        expect(auth?.orgId).toBe(orgId);
      }
    });
  });

  describe("compose job tokens", () => {
    it("should generate a prefixed compose job token", async () => {
      const token = await generateComposeJobToken("user-123", "job-456");

      expect(token.startsWith(SANDBOX_TOKEN_PREFIX)).toBe(true);
      const jwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("should verify a valid compose job token", async () => {
      const token = await generateComposeJobToken("user-123", "job-456");
      const auth = verifyComposeJobToken(token);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.jobId).toBe("job-456");
    });

    it("should return null for expired compose job token", async () => {
      const token = await generateComposeJobToken("user-123", "job-456");

      // Mock time to be 15 minutes in the future (beyond 10 minute expiration)
      const realDateNow = Date.now;
      Date.now = () => {
        return realDateNow() + 15 * 60 * 1000;
      };

      try {
        const auth = verifyComposeJobToken(token);
        expect(auth).toBeNull();
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should return null for token without prefix", () => {
      expect(verifyComposeJobToken("header.payload.signature")).toBeNull();
    });
  });

  describe("zero tokens", () => {
    beforeEach(() => {
      // Default: all feature flags disabled (non-staff user)
      mockIsFeatureEnabled.mockReturnValue(false);
    });

    afterEach(() => {
      mockIsFeatureEnabled.mockReset();
    });

    it("should generate a prefixed zero token", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");

      expect(token.startsWith(SANDBOX_TOKEN_PREFIX)).toBe(true);
      const jwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("should generate different tokens for different runs", async () => {
      const token1 = await generateZeroToken("user-123", "run-1", "org-789");
      const token2 = await generateZeroToken("user-123", "run-2", "org-789");

      expect(token1).not.toBe(token2);
    });

    it("should verify a valid zero token", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.runId).toBe("run-456");
      expect(auth?.orgId).toBe("org-789");
    });

    it("should exclude conditional capabilities when feature flags are disabled", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).toEqual([
        "agent:read",
        "agent:write",
        "agent-run:read",
        "remote-agent:read",
        "remote-agent:write",
        "schedule:read",
        "schedule:write",
        "slack:write",
        "phone:read",
        "phone:write",
        "telegram:read",
        "telegram:write",
        "chat-message:write",
        "chat-message:read",
        "connector:read",
        "file:read",
        "file:write",
      ]);
      expect(auth?.capabilities).not.toContain("agent-run:write");
      expect(auth?.capabilities).not.toContain("computer-use:write");
      expect(auth?.capabilities).not.toContain("local-browser:read");
      expect(auth?.capabilities).not.toContain("host:read");
      expect(auth?.capabilities).not.toContain("host:write");
    });

    it("should include conditional capabilities when feature flags are enabled", async () => {
      mockIsFeatureEnabled.mockReturnValue(true);

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).toContain("computer-use:write");
      expect(auth?.capabilities).toContain("local-browser:read");
      expect(auth?.capabilities).toEqual([
        "agent:read",
        "agent:write",
        "agent-run:read",
        "remote-agent:read",
        "remote-agent:write",
        "local-browser:read",
        "schedule:read",
        "schedule:write",
        "slack:write",
        "phone:read",
        "phone:write",
        "telegram:read",
        "telegram:write",
        "chat-message:write",
        "chat-message:read",
        "connector:read",
        "computer-use:write",
        "file:read",
        "file:write",
        "host:read",
        "host:write",
      ]);
    });

    it("should gate hosted-site capabilities on the hosted-sites feature flag", async () => {
      mockIsFeatureEnabled.mockImplementation((flag) => {
        return flag === FeatureSwitchKey.HostedSites;
      });

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).not.toContain("computer-use:write");
      expect(auth?.capabilities).not.toContain("local-browser:read");
      expect(auth?.capabilities).toContain("host:read");
      expect(auth?.capabilities).toContain("host:write");
    });

    it("should include file:read and file:write capabilities by default", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).toContain("file:read");
      expect(auth?.capabilities).toContain("file:write");
    });

    it("should include telegram read and write capabilities by default", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).toContain("telegram:read");
      expect(auth?.capabilities).toContain("telegram:write");
    });

    it("should include phone read and write capabilities by default", async () => {
      mockIsFeatureEnabled.mockReturnValue(false);

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).toContain("phone:read");
      expect(auth?.capabilities).toContain("phone:write");
    });

    it("should exclude agent-excluded capabilities from zero tokens", async () => {
      mockIsFeatureEnabled.mockReturnValue(true);

      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifyZeroToken(token);

      expect(auth?.capabilities).not.toContain("schedule:delete");
      expect(auth?.capabilities).not.toContain("agent:delete");
      expect(auth?.capabilities).toContain("schedule:write");
    });

    it("should return null for expired zero token", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");

      const realDateNow = Date.now;
      Date.now = () => {
        return realDateNow() + 3 * 60 * 60 * 1000;
      };

      try {
        const auth = verifyZeroToken(token);
        expect(auth).toBeNull();
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should return null for tampered zero token", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const jwt = token.slice(SANDBOX_TOKEN_PREFIX.length);
      const parts = jwt.split(".");
      parts[1] = parts[1] + "tampered";
      const tamperedToken = SANDBOX_TOKEN_PREFIX + parts.join(".");

      const auth = verifyZeroToken(tamperedToken);

      expect(auth).toBeNull();
    });

    it("should return null for token without prefix", () => {
      expect(verifyZeroToken("header.payload.signature")).toBeNull();
    });

    it("should return null for token with empty orgId", async () => {
      const token = await generateZeroToken("user-123", "run-456", "");
      const auth = verifyZeroToken(token);
      expect(auth).toBeNull();
    });

    it("should return null for token with empty runId", async () => {
      const token = await generateZeroToken("user-123", "", "org-789");
      const auth = verifyZeroToken(token);
      expect(auth).toBeNull();
    });

    it("should identify zero tokens with isSandboxToken", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");
      expect(isSandboxToken(token)).toBe(true);
    });
  });

  describe("cross-scope rejection", () => {
    it("should reject sandbox token with verifyComposeJobToken", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const auth = verifyComposeJobToken(token);

      expect(auth).toBeNull();
    });

    it("should reject compose job token with verifySandboxToken", async () => {
      const token = await generateComposeJobToken("user-123", "job-456");
      const auth = verifySandboxToken(token);

      expect(auth).toBeNull();
    });

    it("should reject zero token with verifySandboxToken", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");
      const auth = verifySandboxToken(token);

      expect(auth).toBeNull();
    });

    it("should reject sandbox token with verifyZeroToken", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const auth = verifyZeroToken(token);

      expect(auth).toBeNull();
    });

    it("should reject compose job token with verifyZeroToken", async () => {
      const token = await generateComposeJobToken("user-123", "job-456");
      const auth = verifyZeroToken(token);

      expect(auth).toBeNull();
    });

    it("should identify sandbox/compose/zero token types with isSandboxToken", async () => {
      const sandboxToken = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      const composeToken = await generateComposeJobToken("user-123", "job-456");
      const zeroToken = await generateZeroToken(
        "user-123",
        "run-456",
        "org-789",
      );
      const cliToken = await generateCliToken(
        "user-123",
        "org-789",
        "token-id-1",
      );

      expect(isSandboxToken(sandboxToken)).toBe(true);
      expect(isSandboxToken(composeToken)).toBe(true);
      expect(isSandboxToken(zeroToken)).toBe(true);
      // CLI tokens now use vm0_pat_ prefix, not vm0_sandbox_
      expect(isSandboxToken(cliToken)).toBe(false);
    });

    it("should identify CLI tokens with isPatToken", async () => {
      const cliToken = await generateCliToken(
        "user-123",
        "org-789",
        "token-id-1",
      );
      const sandboxToken = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );

      expect(isPatToken(cliToken)).toBe(true);
      expect(isPatToken(sandboxToken)).toBe(false);
    });

    it("should reject CLI token with verifySandboxToken", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      expect(verifySandboxToken(token)).toBeNull();
    });

    it("should reject CLI token with verifyZeroToken", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      expect(verifyZeroToken(token)).toBeNull();
    });

    it("should reject CLI token with verifyComposeJobToken", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      expect(verifyComposeJobToken(token)).toBeNull();
    });

    it("should reject sandbox token with verifyCliToken", async () => {
      const token = await generateSandboxToken(
        "user-123",
        "run-456",
        "org-test",
      );
      expect(verifyCliToken(token)).toBeNull();
    });

    it("should reject zero token with verifyCliToken", async () => {
      const token = await generateZeroToken("user-123", "run-456", "org-789");
      expect(verifyCliToken(token)).toBeNull();
    });

    it("should reject compose job token with verifyCliToken", async () => {
      const token = await generateComposeJobToken("user-123", "job-456");
      expect(verifyCliToken(token)).toBeNull();
    });
  });

  describe("cli tokens", () => {
    it("should generate a prefixed CLI token with vm0_pat_ prefix", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");

      expect(token.startsWith(PAT_TOKEN_PREFIX)).toBe(true);
      const jwt = token.slice(PAT_TOKEN_PREFIX.length);
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("should generate different tokens for different users", async () => {
      const token1 = await generateCliToken(
        "user-123",
        "org-789",
        "token-id-1",
      );
      const token2 = await generateCliToken(
        "user-456",
        "org-789",
        "token-id-2",
      );

      expect(token1).not.toBe(token2);
    });

    it("should verify a valid CLI token", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      const auth = verifyCliToken(token);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.orgId).toBe("org-789");
      expect(auth?.tokenId).toBe("token-id-1");
    });

    it("should return null for expired CLI token", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");

      // Mock time to be 91 days in the future (beyond 90 day expiration)
      const realDateNow = Date.now;
      Date.now = () => {
        return realDateNow() + 91 * 24 * 60 * 60 * 1000;
      };

      try {
        const auth = verifyCliToken(token);
        expect(auth).toBeNull();
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should verify token within expiration", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");

      // Mock time to be 45 days in the future (within 90 day expiration)
      const realDateNow = Date.now;
      Date.now = () => {
        return realDateNow() + 45 * 24 * 60 * 60 * 1000;
      };

      try {
        const auth = verifyCliToken(token);
        expect(auth).not.toBeNull();
        expect(auth?.userId).toBe("user-123");
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should return null for tampered CLI token", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      const jwt = token.slice(PAT_TOKEN_PREFIX.length);
      const parts = jwt.split(".");
      parts[1] = parts[1] + "tampered";
      const tamperedToken = PAT_TOKEN_PREFIX + parts.join(".");

      expect(verifyCliToken(tamperedToken)).toBeNull();
    });

    it("should return null for token without prefix", () => {
      expect(verifyCliToken("header.payload.signature")).toBeNull();
    });

    it("should return null for token with empty orgId", async () => {
      const token = await generateCliToken("user-123", "", "token-id-1");
      expect(verifyCliToken(token)).toBeNull();
    });

    it("should return null for token with empty tokenId", async () => {
      const token = await generateCliToken("user-123", "org-789", "");
      expect(verifyCliToken(token)).toBeNull();
    });

    it("should identify CLI tokens with isPatToken", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      expect(isPatToken(token)).toBe(true);
      expect(isSandboxToken(token)).toBe(false);
    });

    it("should verify CLI token with legacy vm0_sandbox_ prefix (backward compat)", async () => {
      const token = await generateCliToken("user-123", "org-789", "token-id-1");
      // Replace vm0_pat_ prefix with vm0_sandbox_ to simulate old token
      const legacyToken =
        SANDBOX_TOKEN_PREFIX + token.slice(PAT_TOKEN_PREFIX.length);
      const auth = verifyCliToken(legacyToken);

      expect(auth).not.toBeNull();
      expect(auth?.userId).toBe("user-123");
      expect(auth?.orgId).toBe("org-789");
      expect(auth?.tokenId).toBe("token-id-1");
    });
  });
});
