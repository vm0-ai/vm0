import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentContext,
  type AgentMessage,
  type BashToolInput,
  type EditToolInput,
  type ExecutionEnv,
  type ReadToolInput,
  type WriteToolInput,
} from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";

export type PiAgentTool = NonNullable<AgentContext["tools"]>[number];

type PiExecutionTools = readonly [
  PiAgentTool,
  PiAgentTool,
  PiAgentTool,
  PiAgentTool,
];

function validatedToolArguments(
  tool: Parameters<typeof validateToolArguments>[0],
  toolCallId: string,
  params: unknown,
): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError(`Tool ${tool.name} arguments must be an object`);
  }
  return validateToolArguments(tool, {
    type: "toolCall",
    id: toolCallId,
    name: tool.name,
    arguments: params,
  });
}

export function createPiReadTool(env: ExecutionEnv): PiAgentTool {
  const tool = createReadTool();
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate) {
      const input = validatedToolArguments(
        tool,
        toolCallId,
        params,
      ) as ReadToolInput;
      return tool.execute(toolCallId, input, signal, onUpdate, { env });
    },
  };
}

function createPiBashTool(env: ExecutionEnv): PiAgentTool {
  const tool = createBashTool();
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate) {
      const input = validatedToolArguments(
        tool,
        toolCallId,
        params,
      ) as BashToolInput;
      return tool.execute(toolCallId, input, signal, onUpdate, { env });
    },
  };
}

function createPiWriteTool(env: ExecutionEnv): PiAgentTool {
  const tool = createWriteTool();
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate) {
      const input = validatedToolArguments(
        tool,
        toolCallId,
        params,
      ) as WriteToolInput;
      return tool.execute(toolCallId, input, signal, onUpdate, { env });
    },
  };
}

function createPiEditTool(env: ExecutionEnv): PiAgentTool {
  const tool = createEditTool();
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate) {
      const input = validatedToolArguments(
        tool,
        toolCallId,
        params,
      ) as EditToolInput;
      return tool.execute(toolCallId, input, signal, onUpdate, { env });
    },
  };
}

/** The same native Pi execution tool surface used before and after handoff. */
export function createPiExecutionTools(env: ExecutionEnv): PiExecutionTools {
  return [
    createPiReadTool(env),
    createPiBashTool(env),
    createPiWriteTool(env),
    createPiEditTool(env),
  ] as const;
}

/**
 * Whether an assistant batch must leave the API-backed ExecutionEnv. The Pi
 * edge loop executes no tools, so the first batch that issues any tool call
 * hands off to the sandbox, which then runs it.
 */
export function piMessageRequiresSandbox(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "toolUse" &&
    message.content.some((block) => {
      return block.type === "toolCall";
    })
  );
}
