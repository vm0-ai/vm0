import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { runPiAgentSession as runPiAgentSessionImpl } from "./session";
import type {
  ExecutionEnv,
  PiAgentModelConfig,
  PiAgentSessionResult,
  PiAssistantMessage,
} from "./types";

/**
 * Node-backed ExecutionEnv used by the sandbox Pi loop. Exposed as a
 * factory returning this package's own {@link ExecutionEnv} so consumers never
 * pull the native class declaration into their type program.
 */
export const createPiNodeExecutionEnv: (options: {
  readonly cwd: string;
  readonly shellPath?: string;
  readonly shellEnv?: NodeJS.ProcessEnv;
}) => ExecutionEnv = (options) => {
  return new NodeExecutionEnv({ ...options });
};

/** Run one turn against Pi's native SQLite session repository. */
export async function runPiAgentSession(
  args: {
    readonly sessionId: string;
    readonly databasePath: string;
    readonly model: PiAgentModelConfig;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly executionEnv: ExecutionEnv;
    readonly onAssistantMessage?: (
      message: PiAssistantMessage,
    ) => Promise<void> | void;
  },
  signal: AbortSignal,
): Promise<PiAgentSessionResult> {
  return await runPiAgentSessionImpl(args, signal);
}

export * from "./index";
