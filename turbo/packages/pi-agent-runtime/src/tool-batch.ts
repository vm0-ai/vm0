import {
  validateToolArguments,
  type AssistantMessage,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  ExecutionEnv,
} from "@earendil-works/pi-agent-core";

import { createPiExecutionTools, type PiAgentTool } from "./tools";

type PiAgentEventSink = (event: AgentEvent) => Promise<void> | void;

interface PiToolBatch {
  readonly assistant: AssistantMessage;
  readonly toolCalls: readonly AgentToolCall[];
}

interface PreparedToolCall {
  readonly kind: "prepared";
  readonly toolCall: AgentToolCall;
  readonly tool: PiAgentTool;
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

function latestPiToolBatch(
  messages: readonly AgentMessage[],
): PiToolBatch | null {
  const message = messages.at(-1);
  if (!message || !isAssistantMessage(message)) {
    return null;
  }
  const toolCalls = message.content.filter((block) => {
    return block.type === "toolCall";
  });
  return toolCalls.length === 0 ? null : { assistant: message, toolCalls };
}

function errorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function prepareToolCall(
  tools: readonly PiAgentTool[],
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

async function executeToolCalls(
  batch: PiToolBatch,
  tools: readonly PiAgentTool[],
  signal: AbortSignal,
  onEvent: PiAgentEventSink,
): Promise<readonly ToolResultMessage[]> {
  const finalizedCalls: Array<
    FinalizedToolCall | (() => Promise<FinalizedToolCall>)
  > = [];
  for (const toolCall of batch.toolCalls) {
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

/** Execute the latest assistant tool batch after a database-observed handoff. */
export async function executePiToolBatch(
  args: {
    readonly messages: readonly AgentMessage[];
    readonly executionEnv: ExecutionEnv;
    readonly onEvent: PiAgentEventSink;
  },
  signal: AbortSignal,
): Promise<readonly ToolResultMessage[]> {
  const batch = latestPiToolBatch(args.messages);
  if (!batch) {
    return [];
  }
  const tools: PiAgentTool[] = [...createPiExecutionTools(args.executionEnv)];
  return await executeToolCalls(batch, tools, signal, args.onEvent);
}
