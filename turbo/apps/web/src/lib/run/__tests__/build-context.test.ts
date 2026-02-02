/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { resolveEnvironmentMapping } from "../build-context";

describe("resolveEnvironmentMapping", () => {
  describe("providers with environment mapping (moonshot-api-key)", () => {
    it("resolves credential and model placeholders", () => {
      const result = resolveEnvironmentMapping(
        "moonshot-api-key",
        "sk-moonshot-key-123",
        "kimi-k2.5",
      );

      expect(result).toEqual({
        ANTHROPIC_AUTH_TOKEN: "sk-moonshot-key-123",
        ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
        ANTHROPIC_MODEL: "kimi-k2.5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.5",
        CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k2.5",
      });
    });

    it("uses default model when selectedModel is undefined", () => {
      const result = resolveEnvironmentMapping(
        "moonshot-api-key",
        "sk-moonshot-key-123",
        undefined,
      );

      expect(result.ANTHROPIC_MODEL).toBe("kimi-k2.5");
      expect(result.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot-key-123");
      expect(result.ANTHROPIC_BASE_URL).toBe(
        "https://api.moonshot.ai/anthropic",
      );
    });

    it("passes through literal values (base URL)", () => {
      const result = resolveEnvironmentMapping(
        "moonshot-api-key",
        "sk-key",
        "kimi-k2.5",
      );

      expect(result.ANTHROPIC_BASE_URL).toBe(
        "https://api.moonshot.ai/anthropic",
      );
    });
  });

  describe("providers without environment mapping", () => {
    it("returns single credential for anthropic-api-key", () => {
      const result = resolveEnvironmentMapping(
        "anthropic-api-key",
        "sk-ant-xxx",
        undefined,
      );

      expect(result).toEqual({
        ANTHROPIC_API_KEY: "sk-ant-xxx",
      });
    });

    it("returns single credential for claude-code-oauth-token", () => {
      const result = resolveEnvironmentMapping(
        "claude-code-oauth-token",
        "oauth-token-123",
        undefined,
      );

      expect(result).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-123",
      });
    });

    it("ignores selectedModel for providers without mapping", () => {
      const result = resolveEnvironmentMapping(
        "anthropic-api-key",
        "sk-ant-xxx",
        "some-model", // should be ignored
      );

      // Should only contain the credential, no model env vars
      expect(result).toEqual({
        ANTHROPIC_API_KEY: "sk-ant-xxx",
      });
    });
  });
});
