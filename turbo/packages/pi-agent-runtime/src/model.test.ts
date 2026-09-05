import { zstdDecompressSync } from "node:zlib";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";

const OPENAI_TERRA = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
  dialect: "openai-responses",
} as const;

async function retryableCodexProvider() {
  const requests: Array<{ headers: IncomingHttpHeaders; body: unknown }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      requests.push({
        headers: request.headers,
        body: JSON.parse(
          (request.headers["content-encoding"] === "zstd"
            ? zstdDecompressSync(bytes)
            : bytes
          ).toString("utf8"),
        ) as unknown,
      });
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "stop" } }));
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP provider address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

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
        dialect: "openai-responses",
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
        dialect: "openai-responses",
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
          dialect: "openai-responses",
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
        dialect: "openai-responses",
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

  it.each([
    { dialect: "openai-responses", serviceTier: "fast" },
    { dialect: "openai-codex-responses", serviceTier: "priority" },
  ] as const)(
    "rejects $serviceTier on $dialect before a provider request",
    (policy) => {
      const config = {
        ...OPENAI_TERRA,
        ...policy,
        provider:
          policy.dialect === "openai-codex-responses"
            ? "openai-codex"
            : "openai",
        accountId: "exact-account-id",
        transport: "sse" as const,
      };
      expect(resolvePiAgentModel(config)).toBeNull();
      const model = resolvePiAgentModel({ ...config, serviceTier: undefined });
      if (!model) throw new Error("Expected a supported standard model");
      expect(() => {
        return piAgentStreamForConfig(config)(model, {
          messages: [],
          tools: [],
        });
      }).toThrow("service tier");
    },
  );

  it.each([undefined, "fast"] as const)(
    "passes an explicit account ID to native Codex Responses over SSE with tier %s",
    async (serviceTier) => {
      const provider = await retryableCodexProvider();
      try {
        const config = {
          provider: "openai-codex",
          baseUrl: provider.baseUrl,
          model: "gpt-5.6-terra",
          apiKey: "opaque-not-a-jwt",
          accountId: "account-id-from-binding",
          dialect: "openai-codex-responses",
          transport: "sse",
          serviceTier,
        } as const;
        const model = resolvePiAgentModel(config);
        if (!model || model.api !== "openai-codex-responses") {
          throw new Error("Expected a native Codex Responses model");
        }
        const stream = piAgentStreamForConfig(config)(
          model,
          {
            messages: [{ role: "user", content: "hello", timestamp: 1 }],
            tools: [],
          },
          { apiKey: config.apiKey, serviceTier: "priority" },
        );
        for await (const _event of stream) {
          // Drain the retryable provider error so the adapter completes its task.
        }
        expect(provider.requests).toHaveLength(1);
        const request = provider.requests[0];
        if (serviceTier === undefined) {
          expect(request?.body).not.toHaveProperty("service_tier");
        } else {
          expect(request?.body).toMatchObject({ service_tier: "fast" });
        }
        expect(request?.body).toMatchObject({ store: false, stream: true });
        expect(request?.headers.authorization).toBe("Bearer opaque-not-a-jwt");
        expect(request?.headers["chatgpt-account-id"]).toBe(
          "account-id-from-binding",
        );
      } finally {
        await provider.close();
      }
    },
  );

  it("preserves a native Codex Responses tool call over forced SSE", async () => {
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
    const call = {
      type: "function_call",
      id: "fc_native_tool",
      call_id: "call_native_tool",
      name: "bash",
      arguments: '{"command":"okou --help"}',
      status: "completed",
    };
    const response = {
      id: "resp_native_tool",
      object: "response",
      status: "completed",
      output: [call],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    const providerEvents = [
      {
        type: "response.created",
        response: {
          ...response,
          status: "in_progress",
          output: [],
          usage: null,
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: call.id,
        delta: call.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: call.id,
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response },
    ]
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join("");
    const providerFetch = vi.fn(async () => {
      return new Response(providerEvents, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const stream = piAgentStreamForConfig(config)(
      model,
      {
        messages: [{ role: "user", content: "use a tool", timestamp: 1 }],
        tools: [],
      },
      {
        apiKey: config.apiKey,
        fetch: providerFetch,
        signal: AbortSignal.timeout(5_000),
      },
    );
    for await (const _event of stream) {
      // Drain the native event stream before inspecting its canonical result.
    }

    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "call_native_tool|fc_native_tool",
          name: "bash",
          arguments: { command: "okou --help" },
        },
      ],
    });
  });
});
