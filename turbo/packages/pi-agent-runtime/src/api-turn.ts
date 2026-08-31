import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { piAgentStream } from "./model";
import { MemoryPiSession, runPiFirstModelTurn } from "./session-memory";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type {
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
} from "./api-types";
import { UnsupportedPiResourceSnapshotError } from "./errors";

function projectAssistantContent(
  message: AssistantMessage,
): PiApiAssistantContent[] {
  return message.content.flatMap((content): PiApiAssistantContent[] => {
    switch (content.type) {
      case "text": {
        return [{ type: "text", text: content.text }];
      }
      case "toolCall": {
        return [
          {
            type: "toolCall",
            id: content.id,
            name: content.name,
            arguments: content.arguments,
          },
        ];
      }
      case "thinking": {
        return [];
      }
      default: {
        const unsupportedContent: never = content;
        return unsupportedContent;
      }
    }
  });
}

export function projectPiApiAssistantMessage(
  message: AssistantMessage,
): PiApiAssistantMessage {
  return {
    content: projectAssistantContent(message),
    model: message.model,
    responseId: message.responseId,
    stopReason: message.stopReason,
    timestamp: message.timestamp,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
    },
  };
}

/** Run exactly one provider request using Pi's official prompt and tool schemas. */
export async function runPiApiFirstTurn(
  args: PiApiFirstTurnArgs,
  signal?: AbortSignal,
): Promise<PiApiFirstTurnResult> {
  const memorySession = args.sessionJsonl
    ? MemoryPiSession.fromJsonl(args.sessionJsonl)
    : MemoryPiSession.create({ cwd: args.cwd, id: args.sessionId });
  if (memorySession.getSessionId() !== args.sessionId) {
    throw new Error(
      "Pi resume session id does not match the launch session id",
    );
  }

  let shell: Awaited<ReturnType<typeof createPiAgentSessionForRuntime>>;
  try {
    shell = await createPiAgentSessionForRuntime({
      cwd: args.cwd,
      agentDir: args.agentDir,
      sessionManager: SessionManager.inMemory(args.cwd, {
        id: args.sessionId,
      }),
      model: args.model,
      appendSystemPrompt: args.appendSystemPrompt,
      resourceSnapshot: args.resourceSnapshot,
    });
  } catch (error) {
    throw new UnsupportedPiResourceSnapshotError(
      "Pi could not load the preheated resource snapshot",
      { cause: error },
    );
  }
  try {
    const turn = await runPiFirstModelTurn({
      model: shell.model,
      session: memorySession,
      stream: piAgentStream,
      systemPrompt: shell.session.systemPrompt,
      tools: shell.session.agent.state.tools,
      prompt: args.prompt,
      thinkingLevel: args.model.thinkingLevel,
      streamOptions: {
        apiKey: args.model.apiKey,
        signal,
      },
      ownership: args.ownership,
    });
    return {
      assistantMessage: projectPiApiAssistantMessage(turn.assistantMessage),
      handoffRequired: turn.handoffRequired,
      sessionJsonl: memorySession.toJsonl(),
    };
  } finally {
    shell.session.dispose();
  }
}
