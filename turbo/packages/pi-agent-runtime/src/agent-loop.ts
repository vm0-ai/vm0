import {
  runAgentLoop,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ExecutionEnv,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

import { createPiExecutionTools } from "./tools";

export type PiOpenAICompatibleProvider =
  | "deepseek"
  | "moonshotai"
  | "openai"
  | "openrouter"
  | "vercel-ai-gateway";

export interface PiAgentModelConfig {
  readonly provider: PiOpenAICompatibleProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

function providerModels(provider: PiOpenAICompatibleProvider) {
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

function sourceModel(config: PiAgentModelConfig): Model<Api> | undefined {
  return providerModels(config.provider).find((candidate) => {
    return candidate.id === config.model;
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

const piOpenAICompletionsStream: StreamFn = (model, context, options) => {
  return streamSimple(model as Model<"openai-completions">, context, options);
};

/** Resolve model metadata from Pi's native provider catalog. */
export function resolvePiAgentModel(
  config: PiAgentModelConfig,
): Model<"openai-completions"> | null {
  const source = sourceModel(config);
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
    piOpenAICompletionsStream,
  );
}

export type { AgentEvent as PiAgentEvent, AgentMessage as PiAgentMessage };
