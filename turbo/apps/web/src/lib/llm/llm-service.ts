import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessage, TokenUsage } from "@vm0/core";
import { logger } from "../logger";

const log = logger("service:llm");

interface ChatOptions {
  model: string;
  messages: ChatMessage[];
}

interface ChatResult {
  content: string;
  model: string;
  usage: TokenUsage;
}

/**
 * Create an OpenRouter client with the provided token
 */
function createClient(token: string): OpenRouter {
  return new OpenRouter({
    apiKey: token,
  });
}

/**
 * Non-streaming chat completion
 */
export async function chat(
  token: string,
  options: ChatOptions,
): Promise<ChatResult> {
  const client = createClient(token);

  log.debug("sending chat request", { model: options.model });

  const response = await client.chat.send({
    model: options.model,
    messages: options.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
  });

  const choice = response.choices[0];
  if (!choice?.message?.content) {
    throw new Error("No response content from OpenRouter");
  }

  // Content can be string or array - handle both cases
  const content =
    typeof choice.message.content === "string"
      ? choice.message.content
      : choice.message.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item.type === "text",
          )
          .map((item) => item.text)
          .join("");

  if (!response.usage) {
    throw new Error("No usage data in OpenRouter response");
  }

  if (!response.model) {
    throw new Error("No model in OpenRouter response");
  }

  log.debug("chat request completed", {
    model: response.model,
    totalTokens: response.usage.totalTokens,
  });

  return {
    content,
    model: response.model,
    usage: {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    },
  };
}

/**
 * Streaming chat completion
 * Returns an async iterable that yields text chunks
 */
export async function* chatStream(
  token: string,
  options: ChatOptions,
): AsyncGenerator<string, void, unknown> {
  const client = createClient(token);

  log.debug("starting streaming chat request", { model: options.model });

  const stream = await client.chat.send({
    model: options.model,
    messages: options.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }

  log.debug("streaming chat request completed", { model: options.model });
}
