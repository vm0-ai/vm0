import {
  err as nativeErr,
  ExecutionError as NativeExecutionError,
  FileError as NativeFileError,
  ok as nativeOk,
  type AgentEvent,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { RunSkillSnapshot } from "@vm0/api-contracts/contracts/runners";

import {
  isPiAgentModelSupported as isPiAgentModelSupportedImpl,
  runPiAgentPrompt as runPiAgentPromptImpl,
  runPiAgentResume as runPiAgentResumeImpl,
} from "./agent-loop";
import {
  formatPiUserPrompt as formatPiUserPromptImpl,
  loadPiRunSkills as loadPiRunSkillsImpl,
  PI_BASE_SYSTEM_PROMPT as PI_BASE_SYSTEM_PROMPT_IMPL,
  renderPiSystemPrompt as renderPiSystemPromptImpl,
} from "./runtime";
import {
  isPiEdgeToolName as isPiEdgeToolNameImpl,
  piMessageRequiresSandbox as piMessageRequiresSandboxImpl,
} from "./tools";
import { parsePiAgentMessages as parsePiAgentMessagesImpl } from "./transcript";
import type {
  ExecutionEnv,
  ExecutionErrorConstructor,
  ExecutionError as NativeExecutionErrorShape,
  FileErrorConstructor,
  FileError as NativeFileErrorShape,
  PiAgentMessage,
  PiAgentModelConfig,
  PiRunSkills,
  Result,
  Skill,
} from "./types";

/**
 * Every export below is annotated with this package's own types from
 * `./types`, never with `@earendil-works/*` types. That keeps the emitted
 * `dist/index.d.ts` free of third-party type references, so consuming programs
 * never load the Pi declaration graph. The assignments are also the conformance
 * check: if a mirror in `./types` drifts from the native shape, this file stops
 * compiling.
 */

/**
 * Narrow a native agent message to the LLM turns vm0 persists.
 *
 * The native `AgentMessage` union is wider than {@link PiAgentMessage} because
 * it also covers the harness-only roles (`bashExecution`, `custom`,
 * `branchSummary`, `compactionSummary`). Those are produced by
 * pi-agent-core's session layer, which this package never instantiates: it
 * drives `runAgentLoop`/`runAgentLoopContinue` directly, and the only other
 * emitter is `executePiUnresolvedToolBatch`, which emits tool results. The
 * `null` branch is therefore unreachable rather than tolerant, and exists so
 * the published surface can be typed without referencing native types.
 */
function transcriptMessage(message: AgentMessage): PiAgentMessage | null {
  return message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
    ? message
    : null;
}

function messageSink(
  onMessage: (message: PiAgentMessage) => Promise<void> | void,
): (event: AgentEvent) => Promise<void> {
  return async (event: AgentEvent): Promise<void> => {
    if (event.type !== "message_end") {
      return;
    }
    const message = transcriptMessage(event.message);
    if (!message) {
      return;
    }
    await onMessage(message);
  };
}

export const err: <TValue, TError>(error: TError) => Result<TValue, TError> =
  nativeErr;

export const ok: <TValue, TError>(value: TValue) => Result<TValue, TError> =
  nativeOk;

export const ExecutionError: ExecutionErrorConstructor = NativeExecutionError;

export const FileError: FileErrorConstructor = NativeFileError;

/** Default base prompt used when no user-facing agent identity is available. */
export const PI_BASE_SYSTEM_PROMPT: string = PI_BASE_SYSTEM_PROMPT_IMPL;

/** Apply Pi's native explicit Skill invocation wrapper when requested. */
export const formatPiUserPrompt: (
  prompt: string,
  skills: readonly Skill[],
) => string = formatPiUserPromptImpl;

/** Load only the exact Skill directories pinned in this run's snapshot. */
export const loadPiRunSkills: (
  env: ExecutionEnv,
  snapshot: RunSkillSnapshot,
) => Promise<PiRunSkills> = loadPiRunSkillsImpl;

/** Render the system prompt shared by both Pi runtimes. */
export const renderPiSystemPrompt: (args: {
  readonly agentName: string;
  readonly appendSystemPrompt?: string | null;
  readonly agentInstructions?: string | null;
  readonly memory?: {
    readonly directory: string;
    readonly primaryFile: string;
    readonly prefix: string | null;
  } | null;
  readonly skills: readonly Skill[];
}) => string = renderPiSystemPromptImpl;

/** Whether a tool name runs on the API-backed edge ExecutionEnv. */
export const isPiEdgeToolName: (name: string) => boolean = isPiEdgeToolNameImpl;

/** Whether an assistant batch must leave the API-backed ExecutionEnv. */
export const piMessageRequiresSandbox: (message: PiAgentMessage) => boolean =
  piMessageRequiresSandboxImpl;

/** Whether Pi's native provider catalog knows this model. */
export const isPiAgentModelSupported: (config: PiAgentModelConfig) => boolean =
  isPiAgentModelSupportedImpl;

/** Validate persisted transcript payloads before replaying them into Pi. */
export const parsePiAgentMessages: (
  messages: readonly unknown[],
) => PiAgentMessage[] = parsePiAgentMessagesImpl;

/**
 * Run the native Pi agent loop with the same model, prompt, messages, and
 * ExecutionEnv-driven tools used on both sides of a handoff.
 */
export async function runPiAgentPrompt(args: {
  readonly model: PiAgentModelConfig;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly messages?: readonly PiAgentMessage[];
  readonly executionEnv: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly onMessage: (message: PiAgentMessage) => Promise<void> | void;
}): Promise<void> {
  await runPiAgentPromptImpl({
    model: args.model,
    systemPrompt: args.systemPrompt,
    prompt: args.prompt,
    messages: args.messages,
    executionEnv: args.executionEnv,
    signal: args.signal,
    onEvent: messageSink(args.onMessage),
  });
}

/**
 * Resume a handed-off Pi turn by executing the latest unresolved assistant
 * tool batch in the Sandbox, then continuing the native model loop.
 */
export async function runPiAgentResume(args: {
  readonly model: PiAgentModelConfig;
  readonly systemPrompt: string;
  readonly messages: readonly PiAgentMessage[];
  readonly executionEnv: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly onMessage: (message: PiAgentMessage) => Promise<void> | void;
}): Promise<void> {
  await runPiAgentResumeImpl({
    model: args.model,
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    executionEnv: args.executionEnv,
    signal: args.signal,
    onEvent: messageSink(args.onMessage),
  });
}

/** Error returned by {@link ExecutionEnv} file operations. */
export type FileError = NativeFileErrorShape;

/** Error returned by {@link ExecutionEnv.exec}. */
export type ExecutionError = NativeExecutionErrorShape;

export type {
  ExecutionEnv,
  FileInfo,
  PiAgentMessage,
  PiAgentModelConfig,
  PiOpenAICompatibleProvider,
  PiRunSkills,
  Result,
  Skill,
} from "./types";
