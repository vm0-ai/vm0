import {
  validateToolArguments,
  type AssistantMessage,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core";

import { createPiExecutionTools } from "./tools";

type PiAgentEventSink = (event: AgentEvent) => Promise<void> | void;

interface PiUnresolvedToolBatch {
  readonly assistantIndex: number;
  readonly assistant: AssistantMessage;
  readonly pendingToolCalls: readonly AgentToolCall[];
}

interface PreparedToolCall {
  readonly kind: "prepared";
  readonly toolCall: AgentToolCall;
  readonly tool: AgentTool;
  readonly args: unknown;
}

interface ImmediateToolCall {
  readonly kind: "immediate";
  readonly toolCall: AgentToolCall;
  readonly result: AgentToolResult<unknown>;
  readonly isError: boolean;
}

type ToolCallPreparation = PreparedToolCall | ImmediateToolCall;

interface FinalizedToolCall {
  readonly toolCall: AgentToolCall;
  readonly result: AgentToolResult<unknown>;
  readonly isError: boolean;
}

function isAssistantMessage(
  message: AgentMessage,
): message is AssistantMessage {
  return message.role === "assistant";
}

function completedToolCallIds(
  messages: readonly AgentMessage[],
  afterIndex: number,
): ReadonlySet<string> {
  const completed = new Set<string>();
  for (let index = afterIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "toolResult") {
      completed.add(message.toolCallId);
    }
  }
  return completed;
}

/** Locate the newest assistant tool batch with at least one missing ToolResult. */
export function findPiUnresolvedToolBatch(
  messages: readonly AgentMessage[],
): PiUnresolvedToolBatch | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isAssistantMessage(message)) {
      continue;
    }
    const toolCalls = message.content.filter((block) => {
      return block.type === "toolCall";
    });
    if (toolCalls.length === 0) {
      continue;
    }
    const completed = completedToolCallIds(messages, index);
    const pendingToolCalls = toolCalls.filter((toolCall) => {
      return !completed.has(toolCall.id);
    });
    if (pendingToolCalls.length > 0) {
      return {
        assistantIndex: index,
        assistant: message,
        pendingToolCalls,
      };
    }
  }
  return null;
}

function errorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function prepareToolCall(
  tools: readonly AgentTool[],
  toolCall: AgentToolCall,
  signal: AbortSignal,
): ToolCallPreparation {
  const tool = tools.find((candidate) => {
    return candidate.name === toolCall.name;
  });
  if (!tool) {
    return {
      kind: "immediate",
      toolCall,
      result: errorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }
  try {
    const preparedArguments = tool.prepareArguments?.(toolCall.arguments);
    const preparedToolCall: AgentToolCall =
      preparedArguments === undefined ||
      preparedArguments === toolCall.arguments
        ? toolCall
        : {
            ...toolCall,
            arguments: preparedArguments as AgentToolCall["arguments"],
          };
    const args = validateToolArguments(tool, preparedToolCall);
    if (signal.aborted) {
      return {
        kind: "immediate",
        toolCall,
        result: errorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return { kind: "prepared", toolCall, tool, args };
  } catch (error) {
    return {
      kind: "immediate",
      toolCall,
      result: errorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal,
  onEvent: PiAgentEventSink,
): Promise<FinalizedToolCall> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;
  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partialResult) => {
        if (!acceptingUpdates) {
          return;
        }
        updateEvents.push(
          Promise.resolve(
            onEvent({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { toolCall: prepared.toolCall, result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return {
      toolCall: prepared.toolCall,
      result: errorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCall,
  onEvent: PiAgentEventSink,
): Promise<void> {
  await onEvent({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function toolResultMessage(finalized: FinalizedToolCall): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    usage: finalized.result.usage,
    ...(finalized.result.addedToolNames?.length
      ? { addedToolNames: finalized.result.addedToolNames }
      : {}),
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function executePendingToolCalls(
  batch: PiUnresolvedToolBatch,
  tools: readonly AgentTool[],
  signal: AbortSignal,
  onEvent: PiAgentEventSink,
): Promise<readonly ToolResultMessage[]> {
  const finalizedCalls: Array<
    FinalizedToolCall | (() => Promise<FinalizedToolCall>)
  > = [];
  for (const toolCall of batch.pendingToolCalls) {
    await onEvent({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const preparation = prepareToolCall(tools, toolCall, signal);
    if (preparation.kind === "immediate") {
      const finalized: FinalizedToolCall = preparation;
      await emitToolExecutionEnd(finalized, onEvent);
      finalizedCalls.push(finalized);
    } else {
      finalizedCalls.push(async () => {
        const finalized = await executePreparedToolCall(
          preparation,
          signal,
          onEvent,
        );
        await emitToolExecutionEnd(finalized, onEvent);
        return finalized;
      });
    }
    if (signal.aborted) {
      break;
    }
  }

  const ordered = await Promise.all(
    finalizedCalls.map((entry) => {
      return typeof entry === "function" ? entry() : Promise.resolve(entry);
    }),
  );
  const messages: ToolResultMessage[] = [];
  for (const finalized of ordered) {
    const message = toolResultMessage(finalized);
    await onEvent({ type: "message_start", message });
    await onEvent({ type: "message_end", message });
    messages.push(message);
  }
  return messages;
}

/**
 * Execute only the missing calls from the latest unresolved assistant batch.
 * Tool selection and ExecutionEnv adapters are shared with the ordinary Pi loop.
 */
export async function executePiUnresolvedToolBatch(
  args: {
    readonly messages: readonly AgentMessage[];
    readonly executionEnv: ExecutionEnv;
    readonly onEvent: PiAgentEventSink;
  },
  signal: AbortSignal,
): Promise<readonly ToolResultMessage[]> {
  const batch = findPiUnresolvedToolBatch(args.messages);
  if (!batch) {
    return [];
  }
  const tools = createPiExecutionTools(args.executionEnv).map((tool) => {
    return tool as unknown as AgentTool;
  });
  return await executePendingToolCalls(batch, tools, signal, args.onEvent);
}
