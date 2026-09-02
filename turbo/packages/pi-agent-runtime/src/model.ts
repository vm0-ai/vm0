import {
  stream as streamResponses,
  streamSimple as streamSimpleResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

import type { PiAgentModelConfig } from "./types";
import type { PiAgentStreamOptions } from "./stream-options";

function providerModels(provider: string): readonly Model<Api>[] {
  switch (provider) {
    case "deepseek": {
      return deepseekProvider().getModels();
    }
    case "openai": {
      return openaiProvider().getModels();
    }
    case "openrouter": {
      return openrouterProvider().getModels();
    }
    default: {
      return [];
    }
  }
}

function isResponsesModel(
  model: Model<Api>,
): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function sourceModel(provider: string, model: string): Model<Api> | undefined {
  return providerModels(provider).find((candidate) => {
    return candidate.id === model;
  });
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
    fetch:
      options?.onObservedServiceTier === undefined
        ? base.fetch
        : observeResponsesServiceTier(
            base.fetch ?? globalThis.fetch,
            options.onObservedServiceTier,
          ),
    reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
    serviceTier: options?.serviceTier,
  });
}

function eventData(frame: string): string | null {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => {
      return line === "data" || line.startsWith("data:");
    })
    .map((line) => {
      return line.startsWith("data:") ? line.slice(5).replace(/^ /u, "") : "";
    });
  return data.length === 0 ? null : data.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function terminalResponsesServiceTier(frame: string): {
  readonly terminal: boolean;
  readonly serviceTier: string | null | undefined;
} {
  const data = eventData(frame);
  if (data === null || data === "[DONE]") {
    return { terminal: false, serviceTier: undefined };
  }
  try {
    const event = JSON.parse(data) as unknown;
    if (
      !isRecord(event) ||
      (event.type !== "response.completed" &&
        event.type !== "response.incomplete")
    ) {
      return { terminal: false, serviceTier: undefined };
    }
    const response = event.response;
    if (!isRecord(response)) {
      return { terminal: true, serviceTier: undefined };
    }
    const serviceTier = response.service_tier;
    return {
      terminal: true,
      serviceTier:
        typeof serviceTier === "string" || serviceTier === null
          ? serviceTier
          : undefined,
    };
  } catch {
    // Preserve malformed provider bytes for Pi's canonical stream parser. A
    // missing observation remains standard at the billing boundary.
    return { terminal: false, serviceTier: undefined };
  }
}

function observeResponsesServiceTier(
  providerFetch: typeof globalThis.fetch,
  onObservedServiceTier: NonNullable<
    PiAgentStreamOptions["onObservedServiceTier"]
  >,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await providerFetch(input, init);
    if (response.body === null) {
      return response;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let observed = false;
    const inspectFrame = (frame: string): void => {
      if (observed) {
        return;
      }
      const terminal = terminalResponsesServiceTier(frame);
      if (terminal.terminal) {
        observed = true;
        onObservedServiceTier(terminal.serviceTier);
      }
    };
    const inspectCompleteFrames = (): void => {
      while (true) {
        const boundary = /\r?\n\r?\n/u.exec(buffer);
        if (!boundary || boundary.index === undefined) {
          return;
        }
        inspectFrame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          inspectCompleteFrames();
          controller.enqueue(chunk);
        },
        flush() {
          buffer += decoder.decode();
          inspectCompleteFrames();
          if (buffer.length > 0) {
            inspectFrame(buffer);
          }
        },
      }),
    );
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

export const piAgentStream = (
  model: Model<"openai-responses">,
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (
    options?.serviceTier === undefined &&
    options?.onObservedServiceTier === undefined
  ) {
    return streamSimpleResponses(model, context, options);
  }
  return streamSimpleResponsesWithPolicy(model, context, options);
};

/** Type bridge for Pi's API-generic provider registration callback. */
export const piAgentRegisteredStream = (
  model: Model<Api>,
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (!isResponsesModel(model)) {
    throw new Error(`Pi runtime requires openai-responses, got ${model.api}`);
  }
  return piAgentStream(model, context, options);
};

/** Resolve model metadata from Pi's native provider catalog. */
export function resolvePiAgentModel(
  config: PiAgentModelConfig,
): Model<"openai-responses"> | null {
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
    // Pi's catalog API tag controls only whether its API-specific compatibility
    // metadata is safe to reuse. It never selects Okou's runtime transport.
    ...(source.api === "openai-responses" && source.compat !== undefined
      ? { compat: source.compat }
      : {}),
    api: "openai-responses" as const,
  };
  return base;
}

export function isPiAgentModelSupported(config: PiAgentModelConfig): boolean {
  return resolvePiAgentModel(config) !== null;
}
