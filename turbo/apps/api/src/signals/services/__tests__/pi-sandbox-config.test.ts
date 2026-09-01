import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  resolvePiSandboxModelConfig,
  shouldUsePiExecution,
} from "../pi-sandbox-config";

const OPENAI_TERRA_ROUTE = {
  selectedModel: "gpt-5.6-terra",
  providerType: "openai-api-key",
  upstreamModel: "gpt-5.6-terra",
  modelKeyId: "openai-terra-key",
} as const;

const OPENROUTER_TERRA_ROUTE = {
  selectedModel: "gpt-5.6-terra",
  providerType: "openrouter-codex",
  upstreamModel: "openai/gpt-5.6-terra",
  modelKeyId: "openrouter-terra-key",
} as const;

describe("Pi sandbox model configuration", () => {
  it("resolves the built-in OpenAI Terra primary route", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "built-in",
        concreteType: "openai-api-key",
        environment: { OPENAI_MODEL: "gpt-5.6-terra" },
        selectedModel: "gpt-5.6-terra",
      }),
    ).toStrictEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-terra",
      api: "openai-responses",
      thinkingLevel: "low",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENAI_API_KEY",
    });
  });

  it("translates built-in OpenAI Terra fast mode to priority", () => {
    expect(
      resolvePiSandboxModelConfig(
        {
          type: "built-in",
          concreteType: "openai-api-key",
          environment: { OPENAI_MODEL: "gpt-5.6-terra" },
          selectedModel: "gpt-5.6-terra",
        },
        "fast",
      ),
    ).toStrictEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-terra",
      api: "openai-responses",
      thinkingLevel: "low",
      serviceTier: "priority",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENAI_API_KEY",
    });
  });

  it("resolves the built-in OpenRouter Terra fallback route", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "built-in",
        concreteType: "openrouter-codex",
        environment: {
          OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
          OPENAI_MODEL: "openai/gpt-5.6-terra",
        },
        selectedModel: "gpt-5.6-terra",
      }),
    ).toStrictEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.6-terra",
      api: "openai-completions",
      thinkingLevel: "low",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENROUTER_API_KEY",
    });
  });

  it("classifies fast Terra on OpenRouter as Pi-incompatible", () => {
    expect(
      resolvePiSandboxModelConfig(
        {
          type: "built-in",
          concreteType: "openrouter-codex",
          environment: {
            OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
            OPENAI_MODEL: "openai/gpt-5.6-terra",
          },
          selectedModel: "gpt-5.6-terra",
        },
        "fast",
      ),
    ).toBeNull();
  });

  it("classifies a provider base mismatch as Pi-incompatible", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "built-in",
        concreteType: "openrouter-codex",
        environment: {
          OPENAI_BASE_URL: "https://example.invalid/v1",
          OPENAI_MODEL: "openai/gpt-5.6-terra",
        },
        selectedModel: "gpt-5.6-terra",
      }),
    ).toBeNull();
  });

  it.each(["web", "agent"] as const)(
    "makes standard built-in Terra eligible for %s chat",
    (triggerSource) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "built-in",
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: undefined,
          builtInModelRuntimeRoute: OPENROUTER_TERRA_ROUTE,
          triggerSource,
          featureSwitchContext: {
            overrides: { [FeatureSwitchKey.PiLoop]: true },
          },
        }),
      ).toBeTruthy();
    },
  );

  it.each(["web", "agent"] as const)(
    "makes fast built-in OpenAI Terra eligible for %s chat when both switches are on",
    (triggerSource) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "built-in",
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: "fast",
          builtInModelRuntimeRoute: OPENAI_TERRA_ROUTE,
          triggerSource,
          featureSwitchContext: {
            overrides: {
              [FeatureSwitchKey.PiLoop]: true,
              [FeatureSwitchKey.CodexFastMode]: true,
            },
          },
        }),
      ).toBeTruthy();
    },
  );

  it.each([
    {
      name: "Pi feature switch off",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: OPENAI_TERRA_ROUTE,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: false,
      codexFastModeEnabled: true,
    },
    {
      name: "fast Terra with Codex fast mode off",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: "fast" as const,
      builtInModelRuntimeRoute: OPENAI_TERRA_ROUTE,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: false,
    },
    {
      name: "fast Terra on managed OpenRouter",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: "fast" as const,
      builtInModelRuntimeRoute: OPENROUTER_TERRA_ROUTE,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
    {
      name: "fast Terra without a concrete route",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: "fast" as const,
      builtInModelRuntimeRoute: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
    {
      name: "Terra BYOK",
      modelProviderType: "openai-api-key",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: OPENAI_TERRA_ROUTE,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
    {
      name: "fast Terra BYOK",
      modelProviderType: "openai-api-key",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: "fast" as const,
      builtInModelRuntimeRoute: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
    {
      name: "non-Web trigger",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: OPENAI_TERRA_ROUTE,
      triggerSource: "slack" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
    {
      name: "unbound chat thread",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: OPENAI_TERRA_ROUTE,
      triggerSource: "web" as const,
      chatThreadId: undefined,
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
    {
      name: "unrelated model",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-sol",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: {
        ...OPENAI_TERRA_ROUTE,
        selectedModel: "gpt-5.6-sol",
        upstreamModel: "gpt-5.6-sol",
      },
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: true,
      codexFastModeEnabled: true,
    },
  ])("keeps $name on Codex", (testCase) => {
    expect(
      shouldUsePiExecution({
        chatThreadId: testCase.chatThreadId,
        modelProviderType: testCase.modelProviderType,
        selectedModel: testCase.selectedModel,
        codexServiceTier: testCase.codexServiceTier,
        builtInModelRuntimeRoute: testCase.builtInModelRuntimeRoute,
        triggerSource: testCase.triggerSource,
        featureSwitchContext: {
          overrides: {
            [FeatureSwitchKey.PiLoop]: testCase.piLoopEnabled,
            [FeatureSwitchKey.CodexFastMode]: testCase.codexFastModeEnabled,
          },
        },
      }),
    ).toBeFalsy();
  });

  it("preserves existing built-in DeepSeek Pi routing", () => {
    expect(
      shouldUsePiExecution({
        chatThreadId: "thread-id",
        modelProviderType: "built-in",
        selectedModel: "deepseek-v4-flash",
        codexServiceTier: "fast",
        builtInModelRuntimeRoute: undefined,
        triggerSource: "web",
        featureSwitchContext: {
          overrides: { [FeatureSwitchKey.PiLoop]: true },
        },
      }),
    ).toBeTruthy();
  });
});
