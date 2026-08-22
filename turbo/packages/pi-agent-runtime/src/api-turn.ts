import { SessionManager } from "@earendil-works/pi-coding-agent";

import { piAgentStream } from "./model";
import type { PiPreheatedResourceSnapshot } from "./resources";
import { MemoryPiSession, runPiFirstModelTurn } from "./session-memory";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type { PiAgentModelConfig } from "./types";

export interface PiApiFirstTurnResult {
  readonly assistantMessage: Awaited<
    ReturnType<typeof runPiFirstModelTurn>
  >["assistantMessage"];
  readonly handoffRequired: boolean;
  readonly sessionJsonl: string;
}

export class UnsupportedPiResourceSnapshotError extends Error {}

/** Run exactly one provider request using Pi's official prompt and tool schemas. */
export async function runPiApiFirstTurn(
  args: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionId: string;
    readonly sessionJsonl?: string;
    readonly prompt: string;
    readonly appendSystemPrompt: string | null;
    readonly model: PiAgentModelConfig;
    readonly resourceSnapshot: PiPreheatedResourceSnapshot;
  },
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
      streamOptions: {
        apiKey: args.model.apiKey,
        signal,
      },
    });
    return { ...turn, sessionJsonl: memorySession.toJsonl() };
  } finally {
    shell.session.dispose();
  }
}
