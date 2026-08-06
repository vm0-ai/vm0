import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentMessage,
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type BashToolInput,
  type EditToolDetails,
  type EditToolInput,
  type ExecutionEnv,
  type ReadToolDetails,
  type ReadToolInput,
  type WriteToolInput,
} from "@earendil-works/pi-agent-core";

type PiReadTool = Omit<ReturnType<typeof createReadTool>, "execute"> & {
  execute(
    toolCallId: string,
    params: ReadToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<ReadToolDetails | undefined>,
  ): ReturnType<ReturnType<typeof createReadTool>["execute"]>;
};

type PiBashTool = Omit<ReturnType<typeof createBashTool>, "execute"> & {
  execute(
    toolCallId: string,
    params: BashToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
  ): ReturnType<ReturnType<typeof createBashTool>["execute"]>;
};

type PiWriteTool = Omit<ReturnType<typeof createWriteTool>, "execute"> & {
  execute(
    toolCallId: string,
    params: WriteToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<undefined>,
  ): ReturnType<ReturnType<typeof createWriteTool>["execute"]>;
};

type PiEditTool = Omit<ReturnType<typeof createEditTool>, "execute"> & {
  execute(
    toolCallId: string,
    params: EditToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<EditToolDetails | undefined>,
  ): ReturnType<ReturnType<typeof createEditTool>["execute"]>;
};

type PiExecutionTools = readonly [
  PiReadTool,
  PiBashTool,
  PiWriteTool,
  PiEditTool,
];

export function createPiReadTool(env: ExecutionEnv): PiReadTool {
  const tool = createReadTool();
  return {
    ...tool,
    execute(
      toolCallId: string,
      params: ReadToolInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<ReadToolDetails | undefined>,
    ) {
      return tool.execute(toolCallId, params, signal, onUpdate, { env });
    },
  };
}

function createPiBashTool(env: ExecutionEnv): PiBashTool {
  const tool = createBashTool();
  return {
    ...tool,
    execute(
      toolCallId: string,
      params: BashToolInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
    ) {
      return tool.execute(toolCallId, params, signal, onUpdate, { env });
    },
  };
}

function createPiWriteTool(env: ExecutionEnv): PiWriteTool {
  const tool = createWriteTool();
  return {
    ...tool,
    execute(
      toolCallId: string,
      params: WriteToolInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<undefined>,
    ) {
      return tool.execute(toolCallId, params, signal, onUpdate, { env });
    },
  };
}

function createPiEditTool(env: ExecutionEnv): PiEditTool {
  const tool = createEditTool();
  return {
    ...tool,
    execute(
      toolCallId: string,
      params: EditToolInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<EditToolDetails | undefined>,
    ) {
      return tool.execute(toolCallId, params, signal, onUpdate, { env });
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

export function isPiEdgeToolName(name: string): boolean {
  return name === "read";
}

/** Whether an assistant batch must leave the API-backed ExecutionEnv. */
export function piMessageRequiresSandbox(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "toolUse" &&
    message.content.some((block) => {
      return block.type === "toolCall" && !isPiEdgeToolName(block.name);
    })
  );
}
