import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentContext,
  type AgentMessage,
  type AgentToolResult,
  type BashToolInput,
  type EditToolInput,
  type ExecutionEnv,
  type ReadToolInput,
  type WriteToolInput,
} from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";

export type PiAgentTool = NonNullable<AgentContext["tools"]>[number];

export const PI_TOOL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
export const PI_TOOL_MAX_TIMEOUT_MS = 30 * 60 * 1_000;

interface PiToolTimeoutDetails {
  readonly code: "tool_timeout";
  readonly timeoutMs: number;
}

type PiExecutionTools = readonly [
  PiAgentTool,
  PiAgentTool,
  PiAgentTool,
  PiAgentTool,
];

function piToolTimeoutResult(
  timeoutMs: number,
): AgentToolResult<PiToolTimeoutDetails> {
  return {
    content: [
      {
        type: "text",
        text: `Tool execution timed out after ${timeoutMs / 1_000} seconds`,
      },
    ],
    details: { code: "tool_timeout", timeoutMs },
  };
}

export function isPiToolTimeoutResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("details" in value)) {
    return false;
  }
  const details: unknown = value.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "code" in details &&
    details.code === "tool_timeout" &&
    "timeoutMs" in details &&
    typeof details.timeoutMs === "number"
  );
}

async function executeWithPiToolTimeout<TDetails>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<AgentToolResult<TDetails>>,
): Promise<AgentToolResult<TDetails | PiToolTimeoutDetails>> {
  parentSignal?.throwIfAborted();
  const timeoutController = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectWithReason = () => {
      reject(signal.reason);
    };
    if (signal.aborted) {
      rejectWithReason();
    } else {
      abortListener = rejectWithReason;
      signal.addEventListener("abort", rejectWithReason, { once: true });
    }
  });
  const timeout = setTimeout(() => {
    const error = new Error(
      `Pi tool execution timed out after ${timeoutMs} ms`,
    );
    error.name = "TimeoutError";
    timeoutController.abort(error);
  }, timeoutMs);

  try {
    const result = await Promise.race([execute(signal), aborted]);
    parentSignal?.throwIfAborted();
    return timeoutController.signal.aborted
      ? piToolTimeoutResult(timeoutMs)
      : result;
  } catch (error) {
    parentSignal?.throwIfAborted();
    if (timeoutController.signal.aborted) {
      return piToolTimeoutResult(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function effectiveBashTimeoutMs(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined) {
    return PI_TOOL_DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  return Math.min(timeoutSeconds, PI_TOOL_MAX_TIMEOUT_MS / 1_000) * 1_000;
}

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
      return executeWithPiToolTimeout(
        PI_TOOL_DEFAULT_TIMEOUT_MS,
        signal,
        (executionSignal) => {
          return tool.execute(toolCallId, input, executionSignal, onUpdate, {
            env,
          });
        },
      );
    },
  };
}

function createPiBashTool(env: ExecutionEnv): PiAgentTool {
  const tool = createBashTool();
  const defaultTimeoutSeconds = PI_TOOL_DEFAULT_TIMEOUT_MS / 1_000;
  const maxTimeoutSeconds = PI_TOOL_MAX_TIMEOUT_MS / 1_000;
  return {
    ...tool,
    description: `${tool.description} Commands time out after ${defaultTimeoutSeconds} seconds by default; timeout may be set up to ${maxTimeoutSeconds} seconds.`,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        timeout: {
          ...tool.parameters.properties.timeout,
          description: `Timeout in seconds (optional; default ${defaultTimeoutSeconds}, maximum ${maxTimeoutSeconds})`,
        },
      },
    },
    execute(toolCallId, params, signal, onUpdate) {
      const input = validatedToolArguments(
        tool,
        toolCallId,
        params,
      ) as BashToolInput;
      const timeoutMs = effectiveBashTimeoutMs(input.timeout);
      return executeWithPiToolTimeout(timeoutMs, signal, (executionSignal) => {
        return tool.execute(
          toolCallId,
          { command: input.command },
          executionSignal,
          onUpdate,
          { env },
        );
      });
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
      return executeWithPiToolTimeout(
        PI_TOOL_DEFAULT_TIMEOUT_MS,
        signal,
        (executionSignal) => {
          return tool.execute(toolCallId, input, executionSignal, onUpdate, {
            env,
          });
        },
      );
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
      return executeWithPiToolTimeout(
        PI_TOOL_DEFAULT_TIMEOUT_MS,
        signal,
        (executionSignal) => {
          return tool.execute(toolCallId, input, executionSignal, onUpdate, {
            env,
          });
        },
      );
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
