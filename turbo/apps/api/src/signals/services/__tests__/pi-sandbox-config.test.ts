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
  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "resolves direct %s through Responses",
    (selectedModel) => {
      expect(
        resolvePiSandboxModelConfig({
          type: "built-in",
          concreteType: "deepseek",
          environment: { OPENAI_MODEL: selectedModel },
          selectedModel,
        }),
      ).toStrictEqual({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/",
        model: selectedModel,
        api: "openai-responses",
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "DEEPSEEK_API_KEY",
      });
    },
  );

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
      api: "openai-responses",
      thinkingLevel: "low",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENROUTER_API_KEY",
    });
  });

  it("translates built-in OpenRouter Terra fast mode to priority Responses", () => {
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
    ).toStrictEqual({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.6-terra",
      api: "openai-responses",
      thinkingLevel: "low",
      serviceTier: "priority",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENROUTER_API_KEY",
    });
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "keeps built-in OpenRouter %s fallback on Responses",
    (selectedModel) => {
      expect(
        resolvePiSandboxModelConfig({
          type: "built-in",
          concreteType: "openrouter-codex",
          environment: {
            OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
            OPENAI_MODEL: `deepseek/${selectedModel}`,
          },
          selectedModel,
        }),
      ).toStrictEqual({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: `deepseek/${selectedModel}`,
        api: "openai-responses",
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENROUTER_API_KEY",
      });
    },
  );

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

  it("keeps the Claude Code OpenRouter route outside Pi", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "openrouter-api-key",
        environment: {
          ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
          ANTHROPIC_MODEL: "anthropic/claude-sonnet-5",
        },
        selectedModel: "claude-sonnet-5",
      }),
    ).toBeNull();
  });

  it.each([
    {
      concreteType: "vercel-ai-gateway-codex",
      environment: {
        OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
        OPENAI_MODEL: "gpt-5.6-terra",
      },
    },
    {
      concreteType: "codex-oauth-token",
      environment: {
        OPENAI_BASE_URL: "https://chatgpt.com/backend-api",
        OPENAI_MODEL: "gpt-5.6-terra",
      },
    },
  ] as const)(
    "keeps unreachable $concreteType routes outside the Pi launch config",
    ({ concreteType, environment }) => {
      expect(
        resolvePiSandboxModelConfig({
          type: "built-in",
          concreteType,
          environment,
          selectedModel: "gpt-5.6-terra",
        }),
      ).toBeNull();
    },
  );

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

  it.each(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"] as const)(
    "does not admit built-in %s to Pi on OpenRouter",
    (selectedModel) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "built-in",
          selectedModel,
          codexServiceTier: undefined,
          builtInModelRuntimeRoute: {
            selectedModel,
            providerType: "openrouter-codex",
            upstreamModel: `openai/${selectedModel}`,
            modelKeyId: "openrouter-key",
          },
          triggerSource: "web",
          featureSwitchContext: {
            overrides: {
              [FeatureSwitchKey.PiLoop]: true,
              [FeatureSwitchKey.CodexFastMode]: true,
            },
          },
        }),
      ).toBeFalsy();
    },
  );

  it.each([
    ["OpenAI", "web", OPENAI_TERRA_ROUTE],
    ["OpenAI", "agent", OPENAI_TERRA_ROUTE],
    ["OpenRouter", "web", OPENROUTER_TERRA_ROUTE],
    ["OpenRouter", "agent", OPENROUTER_TERRA_ROUTE],
  ] as const)(
    "makes fast built-in %s Terra eligible for %s chat when both switches are on",
    (_provider, triggerSource, builtInModelRuntimeRoute) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "built-in",
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: "fast",
          builtInModelRuntimeRoute,
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
