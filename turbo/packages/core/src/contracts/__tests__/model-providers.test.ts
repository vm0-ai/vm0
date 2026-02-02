import { describe, it, expect } from "vitest";
import {
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
  getFrameworkForType,
  getCredentialNameForType,
  getEnvironmentMapping,
  getModels,
  getDefaultModel,
  hasModelSelection,
} from "../model-providers";

describe("model-providers helpers", () => {
  describe("modelProviderTypeSchema", () => {
    it("accepts claude-code-oauth-token as valid type", () => {
      expect(
        modelProviderTypeSchema.safeParse("claude-code-oauth-token").success,
      ).toBe(true);
    });

    it("accepts anthropic-api-key as valid type", () => {
      expect(
        modelProviderTypeSchema.safeParse("anthropic-api-key").success,
      ).toBe(true);
    });

    it("accepts moonshot-api-key as valid type", () => {
      expect(
        modelProviderTypeSchema.safeParse("moonshot-api-key").success,
      ).toBe(true);
    });

    it("rejects invalid type", () => {
      expect(
        modelProviderTypeSchema.safeParse("invalid-provider").success,
      ).toBe(false);
    });
  });

  describe("getFrameworkForType", () => {
    it("returns claude-code for anthropic-api-key", () => {
      expect(getFrameworkForType("anthropic-api-key")).toBe("claude-code");
    });

    it("returns claude-code for moonshot-api-key", () => {
      expect(getFrameworkForType("moonshot-api-key")).toBe("claude-code");
    });
  });

  describe("getCredentialNameForType", () => {
    it("returns ANTHROPIC_API_KEY for anthropic-api-key", () => {
      expect(getCredentialNameForType("anthropic-api-key")).toBe(
        "ANTHROPIC_API_KEY",
      );
    });

    it("returns MOONSHOT_API_KEY for moonshot-api-key", () => {
      expect(getCredentialNameForType("moonshot-api-key")).toBe(
        "MOONSHOT_API_KEY",
      );
    });
  });

  describe("getEnvironmentMapping", () => {
    it("returns mapping for moonshot-api-key provider", () => {
      const mapping = getEnvironmentMapping("moonshot-api-key");
      expect(mapping).toEqual({
        ANTHROPIC_AUTH_TOKEN: "$credential",
        ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
        ANTHROPIC_MODEL: "$model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
        CLAUDE_CODE_SUBAGENT_MODEL: "$model",
      });
    });

    it("returns undefined for providers without mapping", () => {
      expect(getEnvironmentMapping("anthropic-api-key")).toBeUndefined();
      expect(getEnvironmentMapping("claude-code-oauth-token")).toBeUndefined();
    });
  });

  describe("getModels", () => {
    it("returns models array for moonshot-api-key", () => {
      expect(getModels("moonshot-api-key")).toEqual([
        "kimi-k2.5",
        "kimi-k2-thinking-turbo",
        "kimi-k2-thinking",
      ]);
    });

    it("returns undefined for providers without models", () => {
      expect(getModels("anthropic-api-key")).toBeUndefined();
      expect(getModels("claude-code-oauth-token")).toBeUndefined();
    });
  });

  describe("getDefaultModel", () => {
    it("returns default model for moonshot-api-key", () => {
      expect(getDefaultModel("moonshot-api-key")).toBe("kimi-k2.5");
    });

    it("returns undefined for providers without models", () => {
      expect(getDefaultModel("anthropic-api-key")).toBeUndefined();
      expect(getDefaultModel("claude-code-oauth-token")).toBeUndefined();
    });
  });

  describe("hasModelSelection", () => {
    it("returns true for moonshot-api-key", () => {
      expect(hasModelSelection("moonshot-api-key")).toBe(true);
    });

    it("returns false for anthropic-api-key", () => {
      expect(hasModelSelection("anthropic-api-key")).toBe(false);
    });

    it("returns false for claude-code-oauth-token", () => {
      expect(hasModelSelection("claude-code-oauth-token")).toBe(false);
    });
  });

  describe("MODEL_PROVIDER_TYPES structure", () => {
    it("has moonshot-api-key provider with correct structure", () => {
      const moonshot = MODEL_PROVIDER_TYPES["moonshot-api-key"];
      expect(moonshot.framework).toBe("claude-code");
      expect(moonshot.credentialName).toBe("MOONSHOT_API_KEY");
      expect(moonshot.label).toBe("Moonshot API Key (Kimi)");
      expect(moonshot.credentialLabel).toBe("API key");
      expect(moonshot.helpText).toContain("moonshot.ai");
    });

    it("has openrouter-api-key provider with correct structure", () => {
      const openrouter = MODEL_PROVIDER_TYPES["openrouter-api-key"];
      expect(openrouter.framework).toBe("claude-code");
      expect(openrouter.credentialName).toBe("OPENROUTER_API_KEY");
      expect(openrouter.label).toBe("OpenRouter API Key");
      expect(openrouter.credentialLabel).toBe("API key");
      expect(openrouter.helpText).toContain("openrouter.ai");
    });
  });

  describe("openrouter-api-key provider", () => {
    it("accepts openrouter-api-key as valid type", () => {
      expect(
        modelProviderTypeSchema.safeParse("openrouter-api-key").success,
      ).toBe(true);
    });

    it("returns claude-code framework", () => {
      expect(getFrameworkForType("openrouter-api-key")).toBe("claude-code");
    });

    it("returns OPENROUTER_API_KEY as credential name", () => {
      expect(getCredentialNameForType("openrouter-api-key")).toBe(
        "OPENROUTER_API_KEY",
      );
    });

    it("returns environment mapping with ANTHROPIC_API_KEY empty", () => {
      const mapping = getEnvironmentMapping("openrouter-api-key");
      expect(mapping).toBeDefined();
      expect(mapping?.ANTHROPIC_AUTH_TOKEN).toBe("$credential");
      expect(mapping?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
      expect(mapping?.ANTHROPIC_API_KEY).toBe("");
      expect(mapping?.ANTHROPIC_MODEL).toBe("$model");
    });

    it("returns empty string as default model (auto mode)", () => {
      expect(getDefaultModel("openrouter-api-key")).toBe("");
    });

    it("has model selection with Claude models only", () => {
      expect(hasModelSelection("openrouter-api-key")).toBe(true);
      const models = getModels("openrouter-api-key");
      expect(models).toContain("anthropic/claude-sonnet-4.5");
      expect(models).toContain("anthropic/claude-opus-4.5");
      expect(models).toContain("anthropic/claude-haiku-4.5");
      expect(models).toHaveLength(3);
    });
  });
});
