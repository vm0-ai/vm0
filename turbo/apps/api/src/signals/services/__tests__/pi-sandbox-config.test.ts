import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  resolvePiSandboxModelConfig,
  shouldUsePiExecution,
} from "../pi-sandbox-config";

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
          triggerSource,
          featureSwitchContext: {
            overrides: { [FeatureSwitchKey.PiLoop]: true },
          },
        }),
      ).toBeTruthy();
    },
  );

  it.each([
    {
      name: "feature switch off",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      enabled: false,
    },
    {
      name: "fast Terra",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: "fast" as const,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      enabled: true,
    },
    {
      name: "Terra BYOK",
      modelProviderType: "openai-api-key",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      enabled: true,
    },
    {
      name: "non-Web trigger",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      triggerSource: "slack" as const,
      chatThreadId: "thread-id",
      enabled: true,
    },
    {
      name: "unbound chat thread",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      triggerSource: "web" as const,
      chatThreadId: undefined,
      enabled: true,
    },
    {
      name: "unrelated model",
      modelProviderType: "built-in",
      selectedModel: "gpt-5.6-sol",
      codexServiceTier: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      enabled: true,
    },
  ])("keeps $name on Codex", (testCase) => {
    expect(
      shouldUsePiExecution({
        chatThreadId: testCase.chatThreadId,
        modelProviderType: testCase.modelProviderType,
        selectedModel: testCase.selectedModel,
        codexServiceTier: testCase.codexServiceTier,
        triggerSource: testCase.triggerSource,
        featureSwitchContext: {
          overrides: { [FeatureSwitchKey.PiLoop]: testCase.enabled },
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
        triggerSource: "web",
        featureSwitchContext: {
          overrides: { [FeatureSwitchKey.PiLoop]: true },
        },
      }),
    ).toBeTruthy();
  });
});
