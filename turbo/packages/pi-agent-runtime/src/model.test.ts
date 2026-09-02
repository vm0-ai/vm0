import { describe, expect, it } from "vitest";

import { resolvePiAgentModel } from "./model";

const OPENAI_TERRA = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
} as const;

describe("Pi agent model adapter", () => {
  it.each([
    undefined,
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
  ] as const)("normalizes legacy api %s to Responses", (api) => {
    const model = resolvePiAgentModel({
      ...OPENAI_TERRA,
      ...(api === undefined ? {} : { api }),
    });

    expect(model).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 12,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 4,
            output: 18,
            cacheRead: 0.4,
            cacheWrite: 5,
          },
        ],
      },
      contextWindow: 272_000,
      maxTokens: 128_000,
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true,
      },
    });
    expect(model).not.toHaveProperty("samplingParams");
  });

  it.each([
    {
      name: "direct DeepSeek Flash",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
    },
    {
      name: "direct DeepSeek Pro",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-pro",
    },
    {
      name: "OpenRouter DeepSeek Flash",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4-flash",
    },
    {
      name: "OpenRouter DeepSeek Pro",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4-pro",
    },
    {
      name: "OpenRouter Terra",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.6-terra",
    },
  ])(
    "projects $name catalog metadata onto Responses without Chat fields",
    (config) => {
      const model = resolvePiAgentModel({
        ...config,
        apiKey: "test-key",
        api: "openai-completions",
      });

      expect(model).toMatchObject({
        id: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
        api: "openai-responses",
      });
      expect(model).not.toHaveProperty("compat");
      expect(model).not.toHaveProperty("samplingParams");
    },
  );

  it("uses product admission instead of a second runtime model allowlist", () => {
    expect(
      resolvePiAgentModel({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        model: "openai/gpt-5.6-sol",
      }),
    ).toMatchObject({
      id: "openai/gpt-5.6-sol",
      api: "openai-responses",
      provider: "openrouter",
    });
  });

  it.each([
    { provider: "unknown", model: "gpt-5.6-terra" },
    { provider: "openai", model: "unknown-model" },
    { provider: "openrouter", model: "unknown/model" },
  ])("fails closed for unknown catalog pair $provider/$model", (config) => {
    expect(
      resolvePiAgentModel({
        ...config,
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
      }),
    ).toBeNull();
  });
});
