import { describe, it, expect } from "vitest";
import {
  getProviderBaseUrl,
  areProvidersCompatible,
  getModels,
  getDefaultModel,
  hasModelSelection,
  getEnvironmentMapping,
  MODEL_PROVIDER_TYPES,
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

describe("minimax model provider", () => {
  it("offers M2.7 and M2.7-highspeed models", () => {
    const models = getModels("minimax-api-key");
    expect(models).toEqual(["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);
  });

  it("defaults to MiniMax-M2.7", () => {
    expect(getDefaultModel("minimax-api-key")).toBe("MiniMax-M2.7");
  });

  it("supports model selection", () => {
    expect(hasModelSelection("minimax-api-key")).toBe(true);
  });

  it("uses Anthropic-compatible base URL", () => {
    expect(getProviderBaseUrl("minimax-api-key")).toBe(
      "https://api.minimax.io/anthropic",
    );
  });

  it("maps environment variables correctly", () => {
    const mapping = getEnvironmentMapping("minimax-api-key");
    expect(mapping).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_MODEL: "$model",
    });
  });

  it("includes minimax M2.7 in vercel-ai-gateway models", () => {
    const config = MODEL_PROVIDER_TYPES["vercel-ai-gateway"];
    expect("models" in config && config.models).toContain(
      "minimax/minimax-m2.7",
    );
  });
});
