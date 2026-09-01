import { describe, expect, it } from "vitest";

import {
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  getModelProviderPiChatCompletionsUrl,
  getModelProviderPiEndpoint,
} from "../model-provider-firewalls";

/**
 * The sandbox never holds a real model credential. It runs with the firewall
 * placeholder and the mitm proxy substitutes the secret at egress, but only for
 * the base URLs a provider's firewall lists, and base matching is a prefix
 * match. So if the Pi sandbox loop's chat-completions URL falls outside every
 * listed base, the placeholder is forwarded verbatim and the provider answers
 * 401. That is exactly what a live sandbox run hit before this coverage existed.
 */
const PI_CAPABLE_PROVIDERS = [
  "deepseek",
  "openai-api-key",
  "codex-oauth-token",
] as const;
type PiCapableProvider = (typeof PI_CAPABLE_PROVIDERS)[number];

/**
 * Actual request URL the Pi runtime calls. DeepSeek uses its native Responses
 * endpoint, most providers use chat completions, and the Codex subscription
 * runtime appends `/codex/responses` to its base URL.
 */
function piRequestUrl(provider: PiCapableProvider): string | undefined {
  if (provider === "deepseek") {
    return "https://api.deepseek.com/responses";
  }
  const url = getModelProviderPiChatCompletionsUrl(provider);
  if (url === undefined) {
    return undefined;
  }
  return provider === "codex-oauth-token" ? `${url}/codex/responses` : url;
}

function firewallAuthBases(provider: string): readonly string[] {
  const configs: Record<
    string,
    {
      apis: readonly {
        base: string;
        auth?: { headers?: Record<string, string> };
      }[];
    }
  > = MODEL_PROVIDER_FIREWALL_CONFIGS;
  return (configs[provider]?.apis ?? [])
    .map((api) => {
      return api;
    })
    .filter((api) => {
      return Object.keys(api.auth?.headers ?? {}).length > 0;
    })
    .map((api) => {
      return api.base;
    });
}

describe("model provider firewall covers the Pi sandbox request", () => {
  it.each(PI_CAPABLE_PROVIDERS)("covers %s", (provider) => {
    const requestUrl = piRequestUrl(provider);
    expect(requestUrl).toBeDefined();

    const bases = firewallAuthBases(provider);
    const covered = bases.some((base) => {
      return requestUrl?.startsWith(base.replace(/\/+$/, ""));
    });

    expect(
      covered,
      `${provider}: Pi calls ${requestUrl}, firewall bases are ${bases.join(", ")}`,
    ).toBe(true);
  });

  it("keeps credential injection scoped to inference paths", () => {
    for (const provider of PI_CAPABLE_PROVIDERS) {
      for (const base of firewallAuthBases(provider)) {
        expect(base).toMatch(
          /\/(chat\/completions|responses|v1\/messages|codex)$/,
        );
      }
    }
  });

  it("exposes no Pi endpoint for providers the Pi loop cannot drive", () => {
    expect(getModelProviderPiChatCompletionsUrl("anthropic-api-key")).toBe(
      undefined,
    );
  });

  it("exposes no chat-completions endpoint for DeepSeek", () => {
    expect(getModelProviderPiChatCompletionsUrl("deepseek")).toBeUndefined();
    expect(firewallAuthBases("deepseek")).toStrictEqual([
      "https://api.deepseek.com/responses",
    ]);
  });

  it.each([
    [
      "openai-api-key",
      "openai-responses",
      "https://api.openai.com/v1",
      "https://api.openai.com/v1/responses",
    ],
    [
      "openrouter-codex",
      "openai-completions",
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai/api/v1/chat/completions",
    ],
  ] as const)(
    "keeps the Terra %s %s runtime and exact firewall paths aligned",
    (provider, api, baseUrl, inferenceUrl) => {
      expect(getModelProviderPiEndpoint(provider, api)).toStrictEqual({
        baseUrl,
        inferenceUrl,
      });
      expect(firewallAuthBases(provider)).toContain(inferenceUrl);
    },
  );

  it("rejects unsupported provider transports before runtime", () => {
    expect(
      getModelProviderPiEndpoint("openrouter-codex", "openai-codex-responses"),
    ).toBeUndefined();
  });
});
