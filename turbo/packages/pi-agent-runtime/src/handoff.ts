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

interface PiHandoffToolBatch {
  readonly assistantIndex: number;
  readonly assistant: AssistantMessage;
  readonly toolCalls: readonly AgentToolCall[];
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

/** Read the exact assistant tool batch at the durable handoff boundary. */
export function piHandoffToolBatch(
  messages: readonly AgentMessage[],
): PiHandoffToolBatch {
  const assistantIndex = messages.length - 1;
  const message = messages[assistantIndex];
  if (!message || !isAssistantMessage(message)) {
    throw new Error("Pi handoff boundary is not an assistant message");
  }
  if (message.stopReason !== "toolUse") {
    throw new Error("Pi handoff assistant did not stop for tool use");
  }
  const toolCalls = message.content.filter((block) => {
    return block.type === "toolCall";
  });
  if (toolCalls.length === 0) {
    throw new Error("Pi handoff assistant contains no tool calls");
  }
  return { assistantIndex, assistant: message, toolCalls };
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
  signal.throwIfAborted();
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
    signal.throwIfAborted();
    return { kind: "prepared", toolCall, tool, args };
  } catch (error) {
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    signal.throwIfAborted();
    return { toolCall: prepared.toolCall, result, isError: false };
  } catch (error) {
    signal.throwIfAborted();
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    signal.throwIfAborted();
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
  signal: AbortSignal,
): Promise<void> {
  await onEvent({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
  signal.throwIfAborted();
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
  batch: PiHandoffToolBatch,
  tools: readonly AgentTool[],
  signal: AbortSignal,
  onEvent: PiAgentEventSink,
): Promise<readonly ToolResultMessage[]> {
  const finalizedCalls: Array<
    FinalizedToolCall | (() => Promise<FinalizedToolCall>)
  > = [];
  for (const toolCall of batch.toolCalls) {
    signal.throwIfAborted();
    await onEvent({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    signal.throwIfAborted();
    const preparation = prepareToolCall(tools, toolCall, signal);
    if (preparation.kind === "immediate") {
      const finalized: FinalizedToolCall = preparation;
      await emitToolExecutionEnd(finalized, onEvent, signal);
      signal.throwIfAborted();
      finalizedCalls.push(finalized);
    } else {
      finalizedCalls.push(async () => {
        const finalized = await executePreparedToolCall(
          preparation,
          signal,
          onEvent,
        );
        signal.throwIfAborted();
        await emitToolExecutionEnd(finalized, onEvent, signal);
        signal.throwIfAborted();
        return finalized;
      });
    }
    signal.throwIfAborted();
  }

  const ordered = await Promise.all(
    finalizedCalls.map((entry) => {
      return typeof entry === "function" ? entry() : Promise.resolve(entry);
    }),
  );
  signal.throwIfAborted();
  const messages: ToolResultMessage[] = [];
  for (const finalized of ordered) {
    const message = toolResultMessage(finalized);
    await onEvent({ type: "message_start", message });
    signal.throwIfAborted();
    await onEvent({ type: "message_end", message });
    signal.throwIfAborted();
    messages.push(message);
  }
  return messages;
}

/**
 * Execute every call from the exact durable handoff boundary. Any transcript
 * content after that assistant message is an invariant violation upstream.
 */
export async function executePiHandoffToolBatch(
  args: {
    readonly messages: readonly AgentMessage[];
    readonly executionEnv: ExecutionEnv;
    readonly onEvent: PiAgentEventSink;
  },
  signal: AbortSignal,
): Promise<readonly ToolResultMessage[]> {
  const batch = piHandoffToolBatch(args.messages);
  const tools = createPiExecutionTools(args.executionEnv).map((tool) => {
    return tool as unknown as AgentTool;
  });
  const messages = await executePendingToolCalls(
    batch,
    tools,
    signal,
    args.onEvent,
  );
  signal.throwIfAborted();
  return messages;
}
