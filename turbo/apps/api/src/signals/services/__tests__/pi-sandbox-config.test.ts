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

  it("does not make Terra eligible for Pi execution", () => {
    expect(
      shouldUsePiExecution({
        chatThreadId: "thread-id",
        modelProviderType: "built-in",
        selectedModel: "gpt-5.6-terra",
        triggerSource: "web",
        featureSwitchContext: {
          overrides: { [FeatureSwitchKey.PiLoop]: true },
        },
      }),
    ).toBeFalsy();
  });
});
