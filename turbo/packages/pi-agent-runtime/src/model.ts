import { streamSimple as streamSimpleCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  stream as streamResponses,
  streamSimple as streamSimpleResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

import type {
  PiAgentApi,
  PiAgentModelConfig,
  PiOpenAICompatibleProvider,
} from "./types";
import type { PiAgentStreamOptions } from "./stream-options";

type PiCatalogProvider = Exclude<PiOpenAICompatibleProvider, "codex">;

function providerModels(provider: PiCatalogProvider) {
  switch (provider) {
    case "deepseek": {
      return deepseekProvider().getModels();
    }
    case "moonshotai": {
      return moonshotaiProvider().getModels();
    }
    case "openai": {
      return openaiProvider().getModels();
    }
    case "openrouter": {
      return openrouterProvider().getModels();
    }
    case "vercel-ai-gateway": {
      return vercelAIGatewayProvider().getModels();
    }
  }
}

function sourceModel(
  provider: PiCatalogProvider,
  model: string,
): Model<Api> | undefined {
  return providerModels(provider).find((candidate) => {
    return candidate.id === model;
  });
}

function supportedPiApi(api: Api): api is PiAgentApi {
  return (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "openai-codex-responses"
  );
}

/** Resolve the VM0-supported transport for a model in Pi's native catalog. */
export function resolvePiAgentModelApi(args: {
  readonly provider: PiOpenAICompatibleProvider;
  readonly model: string;
}): PiAgentApi | null {
  if (args.provider === "codex") {
    const source = openaiCodexProvider()
      .getModels()
      .find((candidate) => {
        return candidate.id === args.model;
      });
    return source && supportedPiApi(source.api) ? source.api : null;
  }

  const source = sourceModel(args.provider, args.model);
  if (!source) {
    return null;
  }
  // Preserve the existing VM0 DeepSeek Responses adapter contract even though
  // the upstream catalog describes these models as Chat Completions models.
  if (args.provider === "deepseek") {
    return "openai-responses";
  }
  return supportedPiApi(source.api) ? source.api : null;
}

// The firewall placeholder is not a real ChatGPT JWT. Pi's Codex transport
// derives ChatGPT-Account-Id from the token, so keep the placeholder JWT-shaped
// until the egress firewall replaces both values with real credentials.
const CODEX_ACCOUNT_ID_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_PLACEHOLDER_ACCOUNT_ID = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function codexAccountIdFromJwt(apiKey: string): string | null {
  try {
    const parts = apiKey.split(".");
    const payloadPart = parts[1];
    if (parts.length !== 3 || payloadPart === undefined) {
      return null;
    }
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload[CODEX_ACCOUNT_ID_CLAIM_PATH] as
      | { chatgpt_account_id?: unknown }
      | undefined;
    return typeof auth?.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : null;
  } catch {
    return null;
  }
}

function codexJwtShape(accountId: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      [CODEX_ACCOUNT_ID_CLAIM_PATH]: { chatgpt_account_id: accountId },
    }),
  );
  return `${header}.${payload}.vm0-placeholder`;
}

function streamSimpleResponsesWithPolicy(
  model: Model<"openai-responses">,
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream {
  const base = buildBaseOptions(model, context, options, options?.apiKey);
  const clampedReasoning =
    options?.reasoning === undefined
      ? undefined
      : clampThinkingLevel(model, options.reasoning);
  return streamResponses(model, context, {
    ...base,
    reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
    serviceTier: options?.serviceTier,
  });
}

export const piAgentStream = (
  model: Model<Api>,
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (
    options?.serviceTier !== undefined &&
    (model.provider !== "openai" || model.api !== "openai-responses")
  ) {
    throw new Error(
      "Pi priority service tier requires the OpenAI Responses transport",
    );
  }
  if (model.api === "openai-codex-responses") {
    const apiKey = options?.apiKey;
    const jwtApiKey =
      apiKey !== undefined && codexAccountIdFromJwt(apiKey) !== null
        ? apiKey
        : codexJwtShape(CODEX_PLACEHOLDER_ACCOUNT_ID);
    return streamSimpleCodex(
      model as Model<"openai-codex-responses">,
      context,
      { ...options, apiKey: jwtApiKey, transport: "sse" },
    );
  }
  if (model.api === "openai-responses") {
    if (options?.serviceTier === undefined) {
      return streamSimpleResponses(
        model as Model<"openai-responses">,
        context,
        options,
      );
    }
    return streamSimpleResponsesWithPolicy(
      model as Model<"openai-responses">,
      context,
      options,
    );
  }
  return streamSimple(model as Model<"openai-completions">, context, options);
};

/** Resolve model metadata from Pi's native provider catalog. */
export function resolvePiAgentModel(
  config: PiAgentModelConfig,
): Model<
  "openai-completions" | "openai-responses" | "openai-codex-responses"
> | null {
  if (config.provider === "codex") {
    const source = openaiCodexProvider()
      .getModels()
      .find((candidate) => {
        return candidate.id === config.model;
      });
    if (
      !source ||
      (config.api !== undefined && source.api !== config.api) ||
      config.serviceTier !== undefined
    ) {
      return null;
    }
    return {
      ...source,
      provider: config.provider,
      baseUrl: config.baseUrl,
    };
  }

  const source = sourceModel(config.provider, config.model);
  if (!source) {
    return null;
  }
  const base = {
    id: source.id,
    name: source.name,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: source.reasoning,
    thinkingLevelMap: source.thinkingLevelMap,
    input: source.input,
    cost: source.cost,
    contextWindow: source.contextWindow,
    maxTokens: source.maxTokens,
    headers: source.headers,
  };
  if (config.provider === "deepseek") {
    if (
      (config.api !== undefined && config.api !== "openai-responses") ||
      config.serviceTier !== undefined
    ) {
      return null;
    }
    return { ...base, api: "openai-responses" };
  }
  const api = config.api ?? "openai-completions";
  if (
    !supportedPiApi(source.api) ||
    (config.api && source.api !== config.api) ||
    (config.serviceTier !== undefined &&
      (config.provider !== "openai" || api !== "openai-responses"))
  ) {
    return null;
  }
  const model = { ...base, api };
  return source.api === api
    ? {
        ...model,
        samplingParams: source.samplingParams,
        compat: source.compat,
      }
    : model;
}

export function isPiAgentModelSupported(config: PiAgentModelConfig): boolean {
  return resolvePiAgentModel(config) !== null;
}
