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
  hasAuthMethods,
  getAuthMethodsForType,
  getDefaultAuthMethod,
  getCredentialsForAuthMethod,
  getCredentialNamesForAuthMethod,
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

  describe("minimax-api-key provider", () => {
    it("accepts minimax-api-key as valid type", () => {
      expect(modelProviderTypeSchema.safeParse("minimax-api-key").success).toBe(
        true,
      );
    });

    it("returns claude-code framework", () => {
      expect(getFrameworkForType("minimax-api-key")).toBe("claude-code");
    });

    it("returns MINIMAX_API_KEY as credential name", () => {
      expect(getCredentialNameForType("minimax-api-key")).toBe(
        "MINIMAX_API_KEY",
      );
    });

    it("returns environment mapping with MiniMax-specific settings", () => {
      const mapping = getEnvironmentMapping("minimax-api-key");
      expect(mapping).toBeDefined();
      expect(mapping?.ANTHROPIC_AUTH_TOKEN).toBe("$credential");
      expect(mapping?.ANTHROPIC_BASE_URL).toBe(
        "https://api.minimax.io/anthropic",
      );
      expect(mapping?.ANTHROPIC_MODEL).toBe("$model");
      expect(mapping?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("$model");
      expect(mapping?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("$model");
      expect(mapping?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("$model");
      expect(mapping?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("$model");
      expect(mapping?.API_TIMEOUT_MS).toBe("3000000");
      expect(mapping?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    });

    it("returns MiniMax-M2.1 as default model", () => {
      expect(getDefaultModel("minimax-api-key")).toBe("MiniMax-M2.1");
    });

    it("has model selection with single model", () => {
      expect(hasModelSelection("minimax-api-key")).toBe(true);
      const models = getModels("minimax-api-key");
      expect(models).toContain("MiniMax-M2.1");
      expect(models).toHaveLength(1);
    });

    it("has correct provider structure", () => {
      const minimax = MODEL_PROVIDER_TYPES["minimax-api-key"];
      expect(minimax.framework).toBe("claude-code");
      expect(minimax.credentialName).toBe("MINIMAX_API_KEY");
      expect(minimax.label).toBe("MiniMax API Key");
      expect(minimax.credentialLabel).toBe("API key");
      expect(minimax.helpText).toContain("minimax.io");
    });
  });

  describe("aws-bedrock provider (multi-auth)", () => {
    it("accepts aws-bedrock as valid type", () => {
      expect(modelProviderTypeSchema.safeParse("aws-bedrock").success).toBe(
        true,
      );
    });

    it("returns claude-code framework", () => {
      expect(getFrameworkForType("aws-bedrock")).toBe("claude-code");
    });

    it("returns undefined for credentialName (multi-auth provider)", () => {
      expect(getCredentialNameForType("aws-bedrock")).toBeUndefined();
    });

    it("has authMethods", () => {
      expect(hasAuthMethods("aws-bedrock")).toBe(true);
    });

    it("returns auth methods config", () => {
      const authMethods = getAuthMethodsForType("aws-bedrock");
      expect(authMethods).toBeDefined();
      expect(Object.keys(authMethods!)).toEqual(["api-key", "access-keys"]);
    });

    it("returns default auth method", () => {
      expect(getDefaultAuthMethod("aws-bedrock")).toBe("api-key");
    });

    it("returns credentials for api-key auth method", () => {
      const creds = getCredentialsForAuthMethod("aws-bedrock", "api-key");
      expect(creds).toBeDefined();
      expect(Object.keys(creds!)).toEqual([
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_REGION",
      ]);
      const bearerToken = creds!["AWS_BEARER_TOKEN_BEDROCK"];
      const region = creds!["AWS_REGION"];
      expect(bearerToken?.required).toBe(true);
      expect(region?.required).toBe(true);
    });

    it("returns credentials for access-keys auth method", () => {
      const creds = getCredentialsForAuthMethod("aws-bedrock", "access-keys");
      expect(creds).toBeDefined();
      expect(Object.keys(creds!)).toEqual([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION",
      ]);
      const accessKeyId = creds!["AWS_ACCESS_KEY_ID"];
      const secretAccessKey = creds!["AWS_SECRET_ACCESS_KEY"];
      const sessionToken = creds!["AWS_SESSION_TOKEN"];
      const region = creds!["AWS_REGION"];
      expect(accessKeyId?.required).toBe(true);
      expect(secretAccessKey?.required).toBe(true);
      expect(sessionToken?.required).toBe(false);
      expect(region?.required).toBe(true);
    });

    it("returns credential names for api-key auth method", () => {
      const names = getCredentialNamesForAuthMethod("aws-bedrock", "api-key");
      expect(names).toEqual(["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]);
    });

    it("returns credential names for access-keys auth method", () => {
      const names = getCredentialNamesForAuthMethod(
        "aws-bedrock",
        "access-keys",
      );
      expect(names).toEqual([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION",
      ]);
    });

    it("returns undefined for invalid auth method", () => {
      expect(
        getCredentialsForAuthMethod("aws-bedrock", "invalid"),
      ).toBeUndefined();
      expect(
        getCredentialNamesForAuthMethod("aws-bedrock", "invalid"),
      ).toBeUndefined();
    });

    it("returns environment mapping with $credentials placeholders", () => {
      const mapping = getEnvironmentMapping("aws-bedrock");
      expect(mapping).toBeDefined();
      expect(mapping?.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(mapping?.AWS_REGION).toBe("$credentials.AWS_REGION");
      expect(mapping?.AWS_BEARER_TOKEN_BEDROCK).toBe(
        "$credentials.AWS_BEARER_TOKEN_BEDROCK",
      );
      expect(mapping?.AWS_ACCESS_KEY_ID).toBe("$credentials.AWS_ACCESS_KEY_ID");
      expect(mapping?.AWS_SECRET_ACCESS_KEY).toBe(
        "$credentials.AWS_SECRET_ACCESS_KEY",
      );
      expect(mapping?.AWS_SESSION_TOKEN).toBe("$credentials.AWS_SESSION_TOKEN");
    });

    it("has correct provider structure", () => {
      const bedrock = MODEL_PROVIDER_TYPES["aws-bedrock"];
      expect(bedrock.framework).toBe("claude-code");
      expect(bedrock.label).toBe("AWS Bedrock");
      expect(bedrock.helpText).toContain("AWS Bedrock");
      expect("authMethods" in bedrock).toBe(true);
      expect("defaultAuthMethod" in bedrock).toBe(true);
      expect("credentialName" in bedrock).toBe(false);
    });
  });

  describe("multi-auth helper functions with legacy providers", () => {
    it("hasAuthMethods returns false for legacy providers", () => {
      expect(hasAuthMethods("anthropic-api-key")).toBe(false);
      expect(hasAuthMethods("moonshot-api-key")).toBe(false);
      expect(hasAuthMethods("minimax-api-key")).toBe(false);
      expect(hasAuthMethods("openrouter-api-key")).toBe(false);
    });

    it("getAuthMethodsForType returns undefined for legacy providers", () => {
      expect(getAuthMethodsForType("anthropic-api-key")).toBeUndefined();
      expect(getAuthMethodsForType("moonshot-api-key")).toBeUndefined();
    });

    it("getDefaultAuthMethod returns undefined for legacy providers", () => {
      expect(getDefaultAuthMethod("anthropic-api-key")).toBeUndefined();
      expect(getDefaultAuthMethod("moonshot-api-key")).toBeUndefined();
    });

    it("getCredentialsForAuthMethod returns undefined for legacy providers", () => {
      expect(
        getCredentialsForAuthMethod("anthropic-api-key", "any"),
      ).toBeUndefined();
    });
  });
});
