import type {
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export interface PiSandboxToolResult {
  readonly content: (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface PiSandboxToolExecutor {
  readonly name: string;
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PiSandboxToolResult>;
}

export interface ResumePendingPiToolCallsOptions {
  readonly session: SessionManager;
  readonly tools: readonly PiSandboxToolExecutor[];
}

function pendingToolCalls(session: SessionManager): ToolCall[] {
  const messages = session.buildSessionContext().messages;
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex === -1) {
    return [];
  }
  const assistantMessage = messages[assistantIndex];
  if (assistantMessage?.role !== "assistant") {
    return [];
  }
  const resolvedIds = new Set(
    messages.slice(assistantIndex + 1).flatMap((message) => {
      return message.role === "toolResult" ? [message.toolCallId] : [];
    }),
  );
  return assistantMessage.content.filter((content): content is ToolCall => {
    return content.type === "toolCall" && !resolvedIds.has(content.id);
  });
}

function failedToolResult(error: unknown): PiSandboxToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

async function executeToolCall(
  toolCall: ToolCall,
  toolsByName: ReadonlyMap<string, PiSandboxToolExecutor>,
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  const executor = toolsByName.get(toolCall.name);
  let result: PiSandboxToolResult;
  try {
    if (!executor) {
      throw new Error(
        `Tool "${toolCall.name}" is not available in the sandbox`,
      );
    }
    result = await executor.execute(toolCall.arguments, signal);
  } catch (error) {
    result = failedToolResult(error);
  }
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError: result.isError ?? false,
    timestamp: Date.now(),
  };
}

/** Execute only the unresolved tool batch left by the API first-turn slot. */
export async function resumePendingPiToolCalls(
  options: ResumePendingPiToolCallsOptions,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const toolsByName = new Map(
    options.tools.map((tool) => {
      return [tool.name, tool] as const;
    }),
  );
  const results: ToolResultMessage[] = [];
  for (const toolCall of pendingToolCalls(options.session)) {
    signal?.throwIfAborted();
    const result = await executeToolCall(toolCall, toolsByName, signal);
    options.session.appendMessage(result);
    results.push(result);
  }
  return results;
}
