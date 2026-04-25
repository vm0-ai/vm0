import { describe, it, expect } from "vitest";
import {
  getProviderBaseUrl,
  areProvidersCompatible,
  hasModelSelection,
  getModels,
  getDefaultModel,
  getEnvironmentMapping,
  getVm0VisibleModels,
  VM0_MODEL_TO_PROVIDER,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  type ModelProviderType,
} from "../model-providers";

describe("getProviderBaseUrl", () => {
  it.each([
    "claude-code-oauth-token",
    "anthropic-api-key",
    "azure-foundry",
    "aws-bedrock",
  ] as ModelProviderType[])("returns null for %s", (type) => {
    expect(getProviderBaseUrl(type)).toBeNull();
  });

  it.each([
    ["openrouter-api-key", "https://openrouter.ai/api"],
    ["moonshot-api-key", "https://api.moonshot.ai/anthropic"],
    ["minimax-api-key", "https://api.minimax.io/anthropic"],
    ["deepseek-api-key", "https://api.deepseek.com/anthropic"],
    ["zai-api-key", "https://api.z.ai/api/anthropic"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh"],
  ] as [ModelProviderType, string][])(
    "returns correct URL for %s",
    (type, expectedUrl) => {
      expect(getProviderBaseUrl(type)).toBe(expectedUrl);
    },
  );
});

describe("areProvidersCompatible", () => {
  const anthropicNative: ModelProviderType[] = [
    "claude-code-oauth-token",
    "anthropic-api-key",
    "azure-foundry",
    "aws-bedrock",
  ];

  const thirdParty: ModelProviderType[] = [
    "openrouter-api-key",
    "moonshot-api-key",
    "minimax-api-key",
    "deepseek-api-key",
    "zai-api-key",
    "vercel-ai-gateway",
  ];

  it("all Anthropic-native providers are mutually compatible", () => {
    for (const a of anthropicNative) {
      for (const b of anthropicNative) {
        expect(areProvidersCompatible(a, b)).toBe(true);
      }
    }
  });

  it("every provider is compatible with itself", () => {
    for (const p of [...anthropicNative, ...thirdParty]) {
      expect(areProvidersCompatible(p, p)).toBe(true);
    }
  });

  it("Anthropic-native is incompatible with third-party providers", () => {
    for (const native of anthropicNative) {
      for (const tp of thirdParty) {
        expect(areProvidersCompatible(native, tp)).toBe(false);
        expect(areProvidersCompatible(tp, native)).toBe(false);
      }
    }
  });

  it("different third-party providers are incompatible", () => {
    expect(areProvidersCompatible("moonshot-api-key", "deepseek-api-key")).toBe(
      false,
    );
    expect(
      areProvidersCompatible("openrouter-api-key", "vercel-ai-gateway"),
    ).toBe(false);
    expect(areProvidersCompatible("minimax-api-key", "zai-api-key")).toBe(
      false,
    );
  });
});

describe("model selection for Anthropic-native providers", () => {
  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s supports model selection",
    (type) => {
      expect(hasModelSelection(type)).toBe(true);
    },
  );

  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s offers sonnet and opus models",
    (type) => {
      const models = getModels(type);
      expect(models).toContain("claude-sonnet-4-6");
      expect(models).toContain("claude-opus-4-6");
      expect(models).toContain("claude-opus-4-7");
    },
  );

  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s defaults to claude-sonnet-4-6",
    (type) => {
      expect(getDefaultModel(type)).toBe("claude-sonnet-4-6");
    },
  );

  it("anthropic-api-key maps ANTHROPIC_MODEL via environment mapping", () => {
    const mapping = getEnvironmentMapping("anthropic-api-key");
    expect(mapping).toBeDefined();
    expect(mapping!["ANTHROPIC_API_KEY"]).toBe("$secret");
    expect(mapping!["ANTHROPIC_MODEL"]).toBe("$model");
  });

  it("claude-code-oauth-token maps ANTHROPIC_MODEL via environment mapping", () => {
    const mapping = getEnvironmentMapping("claude-code-oauth-token");
    expect(mapping).toBeDefined();
    expect(mapping!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("$secret");
    expect(mapping!["ANTHROPIC_MODEL"]).toBe("$model");
  });

  it("Anthropic-native providers have no ANTHROPIC_BASE_URL (use default)", () => {
    expect(getProviderBaseUrl("anthropic-api-key")).toBeNull();
    expect(getProviderBaseUrl("claude-code-oauth-token")).toBeNull();
  });
});

describe("getVm0VisibleModels", () => {
  it("returns all models when no features are provided", () => {
    const models = getVm0VisibleModels();
    expect(models).toContain("kimi-k2.5");
    expect(models).toContain("MiniMax-M2.7");
    expect(models).toContain("glm-5.1");
    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("deepseek-v4-flash");
    // All feature-flagged models must be hidden when no features are provided
    const featureFlaggedModels = Object.entries(VM0_MODEL_TO_PROVIDER)
      .filter(([, config]) => {
        return config.featureFlag !== undefined;
      })
      .map(([model]) => {
        return model;
      });
    for (const model of featureFlaggedModels) {
      expect(models).not.toContain(model);
    }
  });

  it("DeepSeek V4 models and compatibility aliases are not feature gated", () => {
    const models = getVm0VisibleModels({});
    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("deepseek-v4-flash");
  });
});

describe("firewall base URL scoped to /v1/messages (#9560)", () => {
  it.each([
    ["anthropic-api-key", "https://api.anthropic.com/v1/messages"],
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
    ["openrouter-api-key", "https://openrouter.ai/api/v1/messages"],
    ["moonshot-api-key", "https://api.moonshot.ai/anthropic/v1/messages"],
    ["minimax-api-key", "https://api.minimax.io/anthropic/v1/messages"],
    ["deepseek-api-key", "https://api.deepseek.com/anthropic/v1/messages"],
    ["zai-api-key", "https://api.z.ai/api/anthropic/v1/messages"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/messages"],
  ] as const)(
    "%s scopes firewall to /v1/messages path prefix",
    (type, expectedBase) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS[type];
      expect(config.apis).toHaveLength(1);
      expect(config.apis[0]!.base).toBe(expectedBase);
    },
  );
});
