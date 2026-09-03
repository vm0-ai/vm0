import { describe, expect, it, vi } from "vitest";

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";

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
    {
      provider: "deepseek",
      catalogModel: "deepseek-v4-flash",
      model: "company-deepseek-production",
    },
    {
      provider: "openai",
      catalogModel: "gpt-5.6-terra",
      model: "company-terra-production",
    },
  ])(
    "uses $provider/$catalogModel metadata for gateway request model $model",
    (config) => {
      expect(
        resolvePiAgentModel({
          ...config,
          baseUrl: "https://gateway.example.com/v1",
          apiKey: "unused",
        }),
      ).toMatchObject({
        id: config.model,
        provider: config.provider,
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-responses",
      });
    },
  );

  it.each([
    { provider: "unknown", model: "gpt-5.6-terra" },
    { provider: "openai", model: "unknown-model" },
    { provider: "openrouter", model: "unknown/model" },
    {
      provider: "deepseek",
      model: "company-model",
      catalogModel: "unknown-catalog-model",
    },
  ])("fails closed for unknown catalog pair $provider/$model", (config) => {
    expect(
      resolvePiAgentModel({
        ...config,
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
      }),
    ).toBeNull();
  });

  it("selects the native OpenAI Codex catalog only from the Codex dialect", () => {
    expect(
      resolvePiAgentModel({
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-5.6-terra",
        apiKey: "opaque-access-token",
        accountId: "account-id",
        dialect: "openai-codex-responses",
        transport: "sse",
      }),
    ).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
    });
    expect(
      resolvePiAgentModel({
        ...OPENAI_TERRA,
        dialect: "openai-codex-responses",
        accountId: "account-id",
        transport: "sse",
      }),
    ).toBeNull();
  });

  it("passes an explicit account ID to native Codex Responses over SSE", async () => {
    const config = {
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.6-terra",
      apiKey: "opaque-not-a-jwt",
      accountId: "account-id-from-binding",
      dialect: "openai-codex-responses",
      transport: "sse",
    } as const;
    const model = resolvePiAgentModel(config);
    if (!model || model.api !== "openai-codex-responses") {
      throw new Error("Expected a native Codex Responses model");
    }
    let requestHeaders: Headers | undefined;
    const providerFetch = vi.fn(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ error: { message: "stop" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const stream = piAgentStreamForConfig(config)(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [],
      },
      { apiKey: config.apiKey, fetch: providerFetch },
    );
    for await (const _event of stream) {
      // Drain the expected provider error so the adapter completes its task.
    }

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(requestHeaders?.get("authorization")).toBe(
      "Bearer opaque-not-a-jwt",
    );
    expect(requestHeaders?.get("chatgpt-account-id")).toBe(
      "account-id-from-binding",
    );
  });
});
