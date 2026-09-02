import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { createPiAgentSessionForRuntime } from "./session-runtime";
import type {
  PiMemoryRecallOutcome,
  PiMemoryRecallSelection,
} from "./api-types";
import type { PiAgentModelConfig } from "./types";

export type PiSandboxOwnershipTransferMode =
  | "sandbox-first"
  | "pending-tool-continuation"
  | "settled-session-continuation";

async function resolveSessionManager(args: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly sessionFile: string;
}): Promise<SessionManager> {
  const sessionManager = SessionManager.open(
    args.sessionFile,
    args.sessionDir,
    args.cwd,
  );
  if (sessionManager.getSessionId() !== args.sessionId) {
    throw new Error("Pi handoff session id does not match the launch session");
  }
  return sessionManager;
}

function createRuntimeFactory(args: {
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
}): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const created = await createPiAgentSessionForRuntime({
      cwd,
      agentDir,
      sessionManager,
      model: args.model,
      appendSystemPrompt: args.appendSystemPrompt,
      memoryRecall: args.memoryRecall,
      onMemoryRecallOutcome: args.onMemoryRecallOutcome,
      sessionStartEvent,
    });
    return { ...created, diagnostics: created.services.diagnostics };
  };
}

interface InternalAgentSession {
  _runAgentPrompt(messages: Message[]): Promise<void>;
}

function pendingToolCalls(session: AgentSession): {
  readonly assistant: AssistantMessage | null;
  readonly calls: ToolCall[];
} {
  const messages = session.agent.state.messages;
  let lastAssistant: (typeof messages)[number] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      lastAssistant = message;
      break;
    }
  }
  if (lastAssistant?.role !== "assistant") {
    return { assistant: null, calls: [] };
  }
  const resolvedIds = new Set(
    messages.flatMap((message) => {
      return message.role === "toolResult" ? [message.toolCallId] : [];
    }),
  );
  return {
    assistant: lastAssistant,
    calls: lastAssistant.content.filter((content): content is ToolCall => {
      return content.type === "toolCall" && !resolvedIds.has(content.id);
    }),
  };
}

async function executePendingToolCalls(
  session: AgentSession,
): Promise<ToolResultMessage[]> {
  const tools = new Map(
    session.agent.state.tools.map((tool) => {
      return [tool.name, tool] as const;
    }),
  );
  const pending = pendingToolCalls(session);
  const errorResult = (call: ToolCall, message: string): ToolResultMessage => {
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: message }],
      isError: true,
      timestamp: Date.now(),
    };
  };
  if (pending.assistant?.stopReason === "length") {
    return pending.calls.map((call) => {
      return errorResult(
        call,
        `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      );
    });
  }
  const execute = async (call: ToolCall): Promise<ToolResultMessage> => {
    const tool = tools.get(call.name);
    try {
      if (!tool) {
        throw new Error(`Tool "${call.name}" is not available in the sandbox`);
      }
      const preparedCall = tool.prepareArguments
        ? {
            ...call,
            arguments: tool.prepareArguments(
              call.arguments,
            ) as ToolCall["arguments"],
          }
        : call;
      const value = await tool.execute(
        call.id,
        validateToolArguments(tool, preparedCall),
      );
      return {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: value.content ?? [],
        details: value.details,
        usage: value.usage,
        ...(value.addedToolNames?.length
          ? { addedToolNames: value.addedToolNames }
          : {}),
        isError: false,
        timestamp: Date.now(),
      };
    } catch (error) {
      return errorResult(
        call,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const calls = pending.calls;
  if (
    calls.some((call) => {
      return tools.get(call.name)?.executionMode === "sequential";
    })
  ) {
    const results: ToolResultMessage[] = [];
    for (const call of calls) {
      results.push(await execute(call));
    }
    return results;
  }
  return await Promise.all(calls.map(execute));
}

export async function resumePiApiFirstTurn(
  session: AgentSession,
): Promise<void> {
  const internal = session as unknown as InternalAgentSession;
  const pending = pendingToolCalls(session);
  if (pending.calls.length === 0) {
    throw new Error("Pi handoff session contains no pending tool calls");
  }
  const toolResults = await executePendingToolCalls(session);
  await internal._runAgentPrompt(toolResults);
}

function replaceFirstPrompt(
  session: AgentSession,
  continuation: () => Promise<void>,
): void {
  const originalPrompt = session.prompt.bind(session);
  session.prompt = async (_text, options) => {
    session.prompt = originalPrompt;
    options?.preflightResult?.(true);
    await continuation();
  };
}

function installOwnershipTransferStartup(
  session: AgentSession,
  mode: PiSandboxOwnershipTransferMode,
): void {
  switch (mode) {
    case "sandbox-first": {
      return;
    }
    case "pending-tool-continuation": {
      replaceFirstPrompt(session, async () => {
        await resumePiApiFirstTurn(session);
      });
      return;
    }
    case "settled-session-continuation": {
      replaceFirstPrompt(session, () => {
        return Promise.resolve();
      });
      return;
    }
  }
}

/** Run Pi's official AgentSession RPC host until stdin closes. */
export async function runPiOfficialRpcMode(args: {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly sessionFile: string;
  readonly ownershipTransferMode: PiSandboxOwnershipTransferMode;
}): Promise<never> {
  const createRuntime = createRuntimeFactory(args);
  const sessionManager = await resolveSessionManager(args);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: args.cwd,
    agentDir: args.agentDir,
    sessionManager,
  });
  installOwnershipTransferStartup(runtime.session, args.ownershipTransferMode);
  return await runRpcMode(runtime);
}
