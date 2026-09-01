import { describe, expect, it } from "vitest";

import { resolvePiAgentModel } from "./model";

const OPENAI_TERRA = {
  provider: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
};

describe("Pi agent model adapter", () => {
  it("preserves OpenAI Terra's Responses transport and catalog metadata", () => {
    const model = resolvePiAgentModel({
      ...OPENAI_TERRA,
      api: "openai-responses",
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
  });

  it("preserves the managed OpenRouter Terra fallback transport and metadata", () => {
    const model = resolvePiAgentModel({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      model: "openai/gpt-5.6-terra",
      api: "openai-completions",
    });

    expect(model).toMatchObject({
      id: "openai/gpt-5.6-terra",
      provider: "openrouter",
      api: "openai-completions",
      input: ["text", "image"],
      cost: {
        input: 1,
        output: 6,
        cacheRead: 0.1,
        cacheWrite: 1.25,
      },
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      compat: { thinkingFormat: "openrouter" },
    });
  });

  it("rejects a route whose declared transport differs from the Pi catalog", () => {
    expect(
      resolvePiAgentModel({
        ...OPENAI_TERRA,
        api: "openai-completions",
      }),
    ).toBeNull();
  });

  it("limits priority requests to OpenAI Responses", () => {
    expect(
      resolvePiAgentModel({
        ...OPENAI_TERRA,
        api: "openai-responses",
        serviceTier: "priority",
      }),
    ).not.toBeNull();
    expect(
      resolvePiAgentModel({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        model: "openai/gpt-5.6-terra",
        api: "openai-completions",
        serviceTier: "priority",
      }),
    ).toBeNull();
  });

  it("keeps legacy transport defaults and the DeepSeek Responses adapter", () => {
    expect(resolvePiAgentModel(OPENAI_TERRA)?.api).toBe("openai-completions");
    expect(
      resolvePiAgentModel({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/",
        apiKey: "test-key",
        model: "deepseek-v4-flash",
      })?.api,
    ).toBe("openai-responses");
  });
});
