import {
  runAgentLoop,
  runAgentLoopContinue,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ExecutionEnv,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple as streamSimpleCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

import { createPiExecutionTools } from "./tools";
import { executePiUnresolvedToolBatch } from "./recovery";

export const PI_OPENAI_COMPATIBLE_PROVIDERS = [
  "deepseek",
  "moonshotai",
  "openai",
  "openrouter",
  "vercel-ai-gateway",
  "codex",
] as const;

export type PiOpenAICompatibleProvider =
  (typeof PI_OPENAI_COMPATIBLE_PROVIDERS)[number];

type PiOpenAICompletionsProvider = Exclude<PiOpenAICompatibleProvider, "codex">;

export interface PiAgentModelConfig {
  readonly provider: PiOpenAICompatibleProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

function providerModels(provider: PiOpenAICompletionsProvider) {
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
  provider: PiOpenAICompletionsProvider,
  model: string,
): Model<Api> | undefined {
  return providerModels(provider).find((candidate) => {
    return candidate.id === model;
  });
}

function executionTools(env: ExecutionEnv): AgentTool[] {
  return createPiExecutionTools(env).map((tool) => {
    // pi-agent-core's heterogeneous native tool tuple is runtime-compatible
    // with AgentTool[] after its schema validator narrows each call.
    return tool as unknown as AgentTool;
  });
}

function isPiLlmMessage(message: AgentMessage): message is Message {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

// ChatGPT backend account id carried by the firewall placeholder. The Codex
// stream derives `chatgpt-account-id` from the token payload, so the sandbox
// (which only ever holds the firewall placeholder, never a real JWT) needs a
// JWT-shaped key carrying this claim; the egress firewall then replaces the
// Authorization and ChatGPT-Account-Id headers with the real secrets for the
// chatgpt.com backend base.
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

const piAgentStream: StreamFn = (model, context, options) => {
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
  return streamSimple(model as Model<"openai-completions">, context, options);
};

/** Resolve model metadata from Pi's native provider catalog. */
export function resolvePiAgentModel(
  config: PiAgentModelConfig,
): Model<"openai-completions" | "openai-codex-responses"> | null {
  if (config.provider === "codex") {
    const source = openaiCodexProvider()
      .getModels()
      .find((candidate) => {
        return candidate.id === config.model;
      });
    return source
      ? {
          ...source,
          provider: config.provider,
          baseUrl: config.baseUrl,
        }
      : null;
  }

  const source = sourceModel(config.provider, config.model);
  if (!source) {
    return null;
  }
  const base = {
    id: source.id,
    name: source.name,
    api: "openai-completions" as const,
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
  return source.api === "openai-completions"
    ? { ...base, compat: source.compat }
    : base;
}

export function isPiAgentModelSupported(config: PiAgentModelConfig): boolean {
  return resolvePiAgentModel(config) !== null;
}

/**
 * Run the native Pi agent loop with the same model, prompt, messages, and
 * ExecutionEnv-driven tools used on both sides of a handoff.
 */
export async function runPiAgentPrompt(args: {
  readonly model: PiAgentModelConfig;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly messages?: readonly AgentMessage[];
  readonly executionEnv: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AgentEvent) => Promise<void> | void;
}): Promise<readonly AgentMessage[]> {
  const model = resolvePiAgentModel(args.model);
  if (!model) {
    throw new Error(
      `Pi provider ${args.model.provider} does not catalog model ${args.model.model}`,
    );
  }
  const userMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: args.prompt }],
    timestamp: Date.now(),
  };
  return await runAgentLoop(
    [userMessage],
    {
      systemPrompt: args.systemPrompt,
      messages: [...(args.messages ?? [])],
      tools: executionTools(args.executionEnv),
    },
    {
      model,
      apiKey: args.model.apiKey,
      timeoutMs: 120_000,
      convertToLlm(messages) {
        return messages.filter(isPiLlmMessage);
      },
    },
    args.onEvent,
    args.signal,
    piAgentStream,
  );
}

/**
 * Resume a handed-off Pi turn by executing the latest unresolved assistant
 * tool batch in the Sandbox, then continuing the native model loop.
 */
export async function runPiAgentResume(args: {
  readonly model: PiAgentModelConfig;
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly executionEnv: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AgentEvent) => Promise<void> | void;
}): Promise<readonly AgentMessage[]> {
  const model = resolvePiAgentModel(args.model);
  if (!model) {
    throw new Error(
      `Pi provider ${args.model.provider} does not catalog model ${args.model.model}`,
    );
  }
  const messages = [...args.messages];
  const toolResults = await executePiUnresolvedToolBatch({
    messages,
    executionEnv: args.executionEnv,
    signal: args.signal,
    onEvent: args.onEvent,
  });
  if (toolResults.length === 0) {
    throw new Error(
      "Pi transcript has no unresolved assistant tool-call batch",
    );
  }
  messages.push(...toolResults);
  const continued = await runAgentLoopContinue(
    {
      systemPrompt: args.systemPrompt,
      messages,
      tools: executionTools(args.executionEnv),
    },
    {
      model,
      apiKey: args.model.apiKey,
      timeoutMs: 120_000,
      convertToLlm(currentMessages) {
        return currentMessages.filter(isPiLlmMessage);
      },
    },
    args.onEvent,
    args.signal,
    piAgentStream,
  );
  return [...toolResults, ...continued];
}

export type { AgentEvent as PiAgentEvent, AgentMessage as PiAgentMessage };
