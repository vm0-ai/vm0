import { describe, expect, it } from "vitest";
import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
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

const STANDARD_TERRA_API_KEY_ROUTES = [
  {
    type: "openai-api-key",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-terra",
    credentialSecretName: "OPENAI_API_KEY",
  },
  {
    type: "openrouter-codex",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.6-terra",
    credentialSecretName: "OPENROUTER_API_KEY",
  },
  {
    type: "vercel-ai-gateway-codex",
    provider: "openai",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    model: "openai/gpt-5.6-terra",
    catalogModel: "gpt-5.6-terra",
    credentialSecretName: "VERCEL_AI_GATEWAY_API_KEY",
  },
] as const;

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

  it.each([
    {
      selectedModel: "deepseek-v4-flash",
      upstreamModel: "company-deepseek-flash-production",
      provider: "deepseek",
      thinkingLevel: undefined,
    },
    {
      selectedModel: "deepseek-v4-pro",
      upstreamModel: "company-deepseek-pro-production",
      provider: "deepseek",
      thinkingLevel: undefined,
    },
    {
      selectedModel: "gpt-5.6-terra",
      upstreamModel: "company-terra-production",
      provider: "openai",
      thinkingLevel: "low",
    },
  ] as const)(
    "resolves custom gateway $selectedModel to $upstreamModel",
    ({ selectedModel, upstreamModel, provider, thinkingLevel }) => {
      expect(
        resolvePiSandboxModelConfig({
          type: "custom-openai-responses",
          environment: {
            OPENAI_BASE_URL: "https://gateway.example.com/openai/v1",
            OPENAI_MODEL: upstreamModel,
          },
          selectedModel,
          inlineFirewall: true,
          credentialHeader: {
            name: "x-api-key",
            valueTemplate: "Key {{secret}}",
          },
        }),
      ).toStrictEqual({
        provider,
        baseUrl: "https://gateway.example.com/openai/v1",
        model: upstreamModel,
        catalogModel: selectedModel,
        api: "openai-responses",
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OKOU_MODEL_PROVIDER_API_KEY",
        credentialHeader: {
          name: "x-api-key",
          valueTemplate: "Key {{secret}}",
        },
      });
    },
  );

  it("keeps an unmapped custom gateway model outside the Pi config", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "custom-openai-responses",
        environment: {
          OPENAI_BASE_URL: "https://gateway.example.com/openai/v1",
          OPENAI_MODEL: "company-sol-production",
        },
        selectedModel: "gpt-5.6-sol",
        inlineFirewall: true,
        credentialHeader: {
          name: "Authorization",
          valueTemplate: "Bearer {{secret}}",
        },
      }),
    ).toBeNull();
  });

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

  it.each(STANDARD_TERRA_API_KEY_ROUTES)(
    "emits the strict public Responses carrier for $type",
    (route) => {
      expect(
        resolvePiSandboxModelConfig({
          type: route.type,
          environment: {
            OPENAI_API_KEY: "opaque-provider-placeholder",
            ...(route.type === "openai-api-key"
              ? {}
              : { OPENAI_BASE_URL: route.baseUrl }),
            OPENAI_MODEL: route.model,
          },
          selectedModel: "gpt-5.6-terra",
        }),
      ).toStrictEqual({
        schemaVersion: 2,
        dialect: "openai-responses",
        transport: "sse",
        provider: route.provider,
        baseUrl: route.baseUrl,
        model: route.model,
        ...(route.type === "vercel-ai-gateway-codex"
          ? { catalogModel: route.catalogModel }
          : {}),
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "api-key",
            environment: "OPENAI_API_KEY",
            secretName: route.credentialSecretName,
          },
        ],
      });
    },
  );

  it.each([
    {
      name: "fast tier",
      type: "openai-api-key",
      selectedModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      tier: "fast" as const,
    },
    {
      name: "other logical model",
      type: "openai-api-key",
      selectedModel: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      tier: undefined,
    },
    {
      name: "aliased runtime model",
      type: "openrouter-codex",
      selectedModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      tier: undefined,
    },
  ] as const)("rejects API-key Terra with $name", (testCase) => {
    expect(
      resolvePiSandboxModelConfig(
        {
          type: testCase.type,
          environment: {
            OPENAI_API_KEY: "opaque-provider-placeholder",
            ...(testCase.type === "openrouter-codex"
              ? { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" }
              : {}),
            OPENAI_MODEL: testCase.model,
          },
          selectedModel: testCase.selectedModel,
        },
        testCase.tier,
      ),
    ).toBeNull();
  });

  it.each(STANDARD_TERRA_API_KEY_ROUTES)(
    "keeps $type Fast on Codex before Pi ownership",
    (route) => {
      expect(
        resolvePiSandboxModelConfig(
          {
            type: route.type,
            environment: {
              OPENAI_API_KEY: "opaque-provider-placeholder",
              OPENAI_BASE_URL: route.baseUrl,
              OPENAI_MODEL: route.model,
            },
            selectedModel: "gpt-5.6-terra",
          },
          "fast",
        ),
      ).toBeNull();
      expect(
        shouldUsePiExecution({
          modelProviderType: route.type,
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: "fast",
          triggerSource: "web",
          chatThreadId: "thread-1",
          builtInModelRuntimeRoute: undefined,
          featureSwitchContext: {
            userId: "user-1",
            orgId: "org-1",
            overrides: {
              [FeatureSwitchKey.PiLoop]: true,
              [FeatureSwitchKey.CodexFastMode]: true,
            },
          },
        }),
      ).toBeFalsy();
    },
  );

  it("rejects mismatched API-key provider identity and endpoint", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "vercel-ai-gateway-codex",
        concreteType: "openrouter-codex",
        environment: {
          OPENAI_API_KEY: "opaque-provider-placeholder",
          OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
          OPENAI_MODEL: "openai/gpt-5.6-terra",
        },
        selectedModel: "gpt-5.6-terra",
      }),
    ).toBeNull();
  });

  it.each(STANDARD_TERRA_API_KEY_ROUTES)(
    "rejects a base URL mismatch for $type",
    (route) => {
      expect(
        resolvePiSandboxModelConfig({
          type: route.type,
          environment: {
            OPENAI_API_KEY: "opaque-provider-placeholder",
            OPENAI_BASE_URL: "https://mismatched.example.com/v1",
            OPENAI_MODEL: route.model,
          },
          selectedModel: "gpt-5.6-terra",
        }),
      ).toBeNull();
    },
  );

  it("rejects a direct route without its captured API-key binding", () => {
    expect(
      resolvePiSandboxModelConfig({
        type: "openai-api-key",
        environment: { OPENAI_MODEL: "gpt-5.6-terra" },
        selectedModel: "gpt-5.6-terra",
      }),
    ).toBeNull();
  });

  it.each([
    { name: "standard", tier: undefined, generation: 2 },
    { name: "Fast", tier: "fast", generation: 3 },
  ] as const)(
    "emits the strict native Codex carrier for $name subscription Terra",
    ({ tier, generation }) => {
      expect(
        resolvePiSandboxModelConfig(
          {
            type: "codex-oauth-token",
            environment: {
              CHATGPT_ACCESS_TOKEN: "opaque-access-placeholder",
              CHATGPT_ACCOUNT_ID: "opaque-account-placeholder",
              OPENAI_MODEL: "gpt-5.6-terra",
            },
            selectedModel: "gpt-5.6-terra",
          },
          tier,
        ),
      ).toStrictEqual({
        schemaVersion: generation,
        ...(tier === undefined ? {} : { serviceTier: tier }),
        dialect: "openai-codex-responses",
        transport: "sse",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-5.6-terra",
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "access-token",
            environment: "CHATGPT_ACCESS_TOKEN",
            secretName: "CHATGPT_ACCESS_TOKEN",
          },
          {
            kind: "account-id",
            environment: "CHATGPT_ACCOUNT_ID",
            secretName: "CHATGPT_ACCOUNT_ID",
          },
        ],
      });
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"] as const)(
    "keeps subscription %s outside the Pi config",
    (selectedModel) => {
      expect(
        resolvePiSandboxModelConfig({
          type: "codex-oauth-token",
          environment: { OPENAI_MODEL: selectedModel },
          selectedModel,
        }),
      ).toBeNull();
    },
  );

  it.each<{
    name: string;
    override?: Partial<
      NonNullable<Parameters<typeof resolvePiSandboxModelConfig>[0]>
    >;
    environment?: Record<string, string>;
  }>([
    {
      name: "different concrete provider",
      override: { concreteType: "openai-api-key" },
    },
    { name: "inline firewall", override: { inlineFirewall: true } },
    {
      name: "custom header",
      override: {
        credentialHeader: {
          name: "Authorization",
          valueTemplate: "Bearer {{secret}}",
        },
      },
    },
    {
      name: "different endpoint",
      environment: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
    },
    {
      name: "different runtime model",
      environment: { OPENAI_MODEL: "gpt-5.6-sol" },
    },
    { name: "missing access token", environment: { CHATGPT_ACCESS_TOKEN: "" } },
    { name: "missing account ID", environment: { CHATGPT_ACCOUNT_ID: "" } },
  ])("fails closed for subscription Fast with $name", (scenario) => {
    expect(
      resolvePiSandboxModelConfig(
        {
          type: "codex-oauth-token",
          selectedModel: "gpt-5.6-terra",
          ...scenario.override,
          environment: {
            OPENAI_MODEL: "gpt-5.6-terra",
            CHATGPT_ACCESS_TOKEN: "opaque-access-placeholder",
            CHATGPT_ACCOUNT_ID: "opaque-account-placeholder",
            ...scenario.environment,
          },
        },
        "fast",
      ),
    ).toBeNull();
  });

  it.each(
    triggerSourceSchema.options.flatMap((triggerSource) => {
      return [true, false].flatMap((bound) => {
        return [true, false].flatMap((piLoop) => {
          return [true, false].map((fastMode) => {
            return { triggerSource, bound, piLoop, fastMode };
          });
        });
      });
    }),
  )(
    "routes subscription Fast for $triggerSource bound=$bound Pi=$piLoop Fast=$fastMode",
    ({ triggerSource, bound, piLoop, fastMode }) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: bound ? "thread-id" : undefined,
          modelProviderType: "codex-oauth-token",
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: "fast",
          builtInModelRuntimeRoute: undefined,
          triggerSource,
          featureSwitchContext: {
            overrides: {
              [FeatureSwitchKey.PiLoop]: piLoop,
              [FeatureSwitchKey.CodexFastMode]: fastMode,
            },
          },
        }),
      ).toBe(
        bound &&
          piLoop &&
          fastMode &&
          (triggerSource === "web" || triggerSource === "agent"),
      );
    },
  );

  it.each([
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "deepseek-v4-flash",
    "gpt-5.6-terra-fast",
  ])("keeps subscription Fast %s outside Pi", (selectedModel) => {
    expect(
      shouldUsePiExecution({
        chatThreadId: "thread-id",
        modelProviderType: "codex-oauth-token",
        selectedModel,
        codexServiceTier: "fast",
        builtInModelRuntimeRoute: undefined,
        triggerSource: "web",
        featureSwitchContext: {
          overrides: {
            [FeatureSwitchKey.PiLoop]: true,
            [FeatureSwitchKey.CodexFastMode]: true,
          },
        },
      }),
    ).toBeFalsy();
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

  it.each(
    STANDARD_TERRA_API_KEY_ROUTES.flatMap((route) => {
      return (["web", "agent"] as const).map((triggerSource) => {
        return { type: route.type, triggerSource };
      });
    }),
  )(
    "makes standard $type Terra eligible for $triggerSource chat",
    ({ type, triggerSource }) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: type,
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: undefined,
          builtInModelRuntimeRoute: undefined,
          triggerSource,
          featureSwitchContext: {
            overrides: { [FeatureSwitchKey.PiLoop]: true },
          },
        }),
      ).toBeTruthy();
    },
  );

  it.each(["web", "agent"] as const)(
    "makes standard subscription Terra eligible for %s chat",
    (triggerSource) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "codex-oauth-token",
          selectedModel: "gpt-5.6-terra",
          codexServiceTier: undefined,
          builtInModelRuntimeRoute: undefined,
          triggerSource,
          featureSwitchContext: {
            overrides: { [FeatureSwitchKey.PiLoop]: true },
          },
        }),
      ).toBeTruthy();
    },
  );

  it.each(["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-terra"] as const)(
    "admits custom gateway %s to standard Pi",
    (selectedModel) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "custom-openai-responses",
          selectedModel,
          codexServiceTier: undefined,
          builtInModelRuntimeRoute: undefined,
          triggerSource: "web",
          featureSwitchContext: {
            overrides: { [FeatureSwitchKey.PiLoop]: true },
          },
        }),
      ).toBeTruthy();
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"] as const)(
    "does not widen custom gateway admission to %s",
    (selectedModel) => {
      expect(
        shouldUsePiExecution({
          chatThreadId: "thread-id",
          modelProviderType: "custom-openai-responses",
          selectedModel,
          codexServiceTier: undefined,
          builtInModelRuntimeRoute: undefined,
          triggerSource: "web",
          featureSwitchContext: {
            overrides: { [FeatureSwitchKey.PiLoop]: true },
          },
        }),
      ).toBeFalsy();
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
      name: "API-key Terra with Pi feature switch off",
      modelProviderType: "openai-api-key",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: false,
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
      name: "subscription Terra with Pi feature switch off",
      modelProviderType: "codex-oauth-token",
      selectedModel: "gpt-5.6-terra",
      codexServiceTier: undefined,
      builtInModelRuntimeRoute: undefined,
      triggerSource: "web" as const,
      chatThreadId: "thread-id",
      piLoopEnabled: false,
      codexFastModeEnabled: true,
    },
    {
      name: "fast Terra custom gateway",
      modelProviderType: "custom-openai-responses",
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
