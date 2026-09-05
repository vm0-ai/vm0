import { readFileSync } from "node:fs";

import {
  createAgentSessionRuntime,
  runRpcMode,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import {
  parseValidatedPiSessionJsonl,
  validatePiSessionEntries,
} from "./session-validation";
import { createPiAgentSessionForRuntime } from "./session-runtime";
import type {
  PiMemoryRecallOutcome,
  PiMemoryRecallSelection,
  PiMemoryToolSourceUse,
} from "./api-types";
import type { PiAgentModelConfig } from "./types";

export type PiSandboxOwnershipTransferMode =
  | "sandbox-first"
  | "pending-tool-continuation"
  | "settled-session-continuation";

function resolveSessionManager(args: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly sessionFile: string;
}): SessionManager {
  // Keep the read, validation and SDK open synchronous: opening can migrate
  // and rewrite a legacy file. Reject invalid bytes and identity before that.
  const { header } = parseValidatedPiSessionJsonl(
    new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(args.sessionFile),
    ),
  );
  if (header.id !== args.sessionId) {
    throw new Error("Pi handoff session id does not match the launch session");
  }
  const sessionManager = SessionManager.open(
    args.sessionFile,
    args.sessionDir,
    args.cwd,
  );
  if (sessionManager.getSessionId() !== args.sessionId) {
    throw new Error("Pi handoff session id does not match the launch session");
  }
  // Validate the actual SDK-loaded entries before any context traversal, too.
  validatePiSessionEntries(sessionManager.getEntries());
  return sessionManager;
}

function createRuntimeFactory(args: {
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
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
      onMemoryToolSourceUse: args.onMemoryToolSourceUse,
      sessionStartEvent,
    });
    return { ...created, diagnostics: created.services.diagnostics };
  };
}

export async function resumePiApiFirstTurn(
  session: AgentSession,
  options?: Parameters<AgentSession["continuePendingTools"]>[0],
): Promise<void> {
  await session.continuePendingTools(options);
}

function installOwnershipTransferStartup(
  session: AgentSession,
  mode: PiSandboxOwnershipTransferMode,
): void {
  if (mode === "sandbox-first") {
    return;
  }
  const originalPrompt = session.prompt.bind(session);
  session.prompt = async (_text, options) => {
    if (mode === "pending-tool-continuation") {
      await resumePiApiFirstTurn(session, {
        preflightResult(success) {
          // Both native owners are established before ordinary input or RPC ack.
          session.prompt = originalPrompt;
          options?.preflightResult?.(success);
        },
      });
    } else {
      session.prompt = originalPrompt;
      options?.preflightResult?.(true);
    }
  };
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
  readonly onMemoryToolSourceUse?: (sourceUse: PiMemoryToolSourceUse) => void;
  readonly sessionFile: string;
  readonly ownershipTransferMode: PiSandboxOwnershipTransferMode;
}): Promise<never> {
  const createRuntime = createRuntimeFactory(args);
  const sessionManager = resolveSessionManager(args);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: args.cwd,
    agentDir: args.agentDir,
    sessionManager,
  });
  installOwnershipTransferStartup(runtime.session, args.ownershipTransferMode);
  return await runRpcMode(runtime);
}
