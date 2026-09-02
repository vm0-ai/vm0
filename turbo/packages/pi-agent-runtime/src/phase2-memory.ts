import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  InMemoryCredentialStore,
  registerSessionResourceCleanup,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import {
  baseHasValidConsolidatedArtifacts,
  createPiMemoryPhase2Workspace,
  mapsEqual,
  Phase2InputInvalidError,
  Phase2OutputInvalidError,
  preparedSetFromSnapshot,
  removePiMemoryPhase2Workspace,
  snapshotPiMemoryPhase2Input,
  type Phase2PrivateWorkspace,
  type SnapshotPhase2Input,
  validatePiMemoryPhase2Output,
} from "./phase2-memory-filesystem";
import { renderPiMemoryPhase2Prompt } from "./phase2-memory-prompt";
import {
  createPiMemoryPhase2Tools,
  PI_MEMORY_PHASE2_TOOL_NAMES,
  type Phase2MemoryToolTestHooks,
} from "./phase2-memory-tools";
import {
  PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
  PI_MEMORY_PHASE2_MAINTENANCE_REASONING,
  PiMemoryPhase2EngineError,
  type PiMemoryPhase2ConsolidationArgs,
  type PiMemoryPhase2ConsolidationResult,
  type PiMemoryPhase2FailureClass,
  type PiMemoryPhase2FailureCounts,
  type PiMemoryPhase2LifecycleEvent,
  type PiMemoryPhase2ProviderUsage,
} from "./phase2-memory-types";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";

const ZERO_USAGE: PiMemoryPhase2ProviderUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});
const PI_MEMORY_PHASE2_SESSION_CWD = "/phase2-memory";

interface Phase2RuntimeState {
  heartbeatCount: number;
  fileCount: number;
  totalBytes: number;
}

export interface PiMemoryPhase2SessionSnapshot {
  readonly toolNames: readonly string[];
  readonly thinkingLevel: string;
  readonly sessionFile: string | undefined;
  readonly extensions: number;
  readonly skills: number;
  readonly prompts: number;
  readonly themes: number;
  readonly agentsFiles: number;
  readonly appendSystemPrompts: number;
  readonly systemPromptDigest: string;
}

export interface PiMemoryPhase2EngineTestHooks {
  readonly waitForHeartbeat?: (
    signal: AbortSignal,
    cadenceMs: number,
  ) => Promise<void>;
  readonly onSessionCreated?: (snapshot: PiMemoryPhase2SessionSnapshot) => void;
  readonly beforeOutputValidation?: (
    workspace: Phase2PrivateWorkspace,
  ) => Promise<void>;
  readonly beforeCleanup?: (root: string) => Promise<void>;
  readonly tools?: Phase2MemoryToolTestHooks;
}

function initializePiSessionResourceRegistry(): void {
  const unregister = registerSessionResourceCleanup(() => {
    return undefined;
  });
  unregister();
}

function registeredModelConfig(
  model: NonNullable<ReturnType<typeof resolvePiAgentModel>>,
  input: SnapshotPhase2Input,
) {
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey: input.model.apiKey,
    api: model.api,
    streamSimple: piAgentStreamForConfig(input.model),
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        headers: model.headers,
        compat: model.compat,
      },
    ],
  };
}

function failureCounts(
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
): PiMemoryPhase2FailureCounts {
  return {
    candidateCount: input?.selected.length ?? 0,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    heartbeatCount: state.heartbeatCount,
  };
}

function engineError(
  errorClass: PiMemoryPhase2FailureClass,
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
): PiMemoryPhase2EngineError {
  return new PiMemoryPhase2EngineError(errorClass, failureCounts(input, state));
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function lifecycleEvent(
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
  startedAt: number,
  stage: PiMemoryPhase2LifecycleEvent["stage"],
  extra: Pick<
    PiMemoryPhase2LifecycleEvent,
    "contentIdentity" | "errorClass" | "outcome"
  > = {},
): PiMemoryPhase2LifecycleEvent {
  return {
    stage,
    orgId: input.orgId,
    userId: input.userId,
    memoryStorageId: input.memoryStorageId,
    claimedRevision: input.claimedRevision,
    selectionDigest: input.selectionDigest,
    candidateCount: input.selected.length,
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    heartbeatCount: state.heartbeatCount,
    durationMs: durationMs(startedAt),
    ...(extra.outcome === undefined ? {} : { outcome: extra.outcome }),
    ...(extra.errorClass === undefined ? {} : { errorClass: extra.errorClass }),
    ...(extra.contentIdentity === undefined
      ? {}
      : { contentIdentity: extra.contentIdentity }),
  };
}

function emitLifecycle(
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
  startedAt: number,
  stage: PiMemoryPhase2LifecycleEvent["stage"],
  extra?: Pick<
    PiMemoryPhase2LifecycleEvent,
    "contentIdentity" | "errorClass" | "outcome"
  >,
): void {
  try {
    input.onLifecycle?.(lifecycleEvent(input, state, startedAt, stage, extra));
  } catch {
    throw engineError("observer_failed", input, state);
  }
}

function emitFailure(
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
  startedAt: number,
  failure: PiMemoryPhase2EngineError,
): void {
  if (!input) {
    return;
  }
  try {
    input.onLifecycle?.(
      lifecycleEvent(input, state, startedAt, "failed", {
        errorClass: failure.errorClass,
      }),
    );
  } catch {
    // Preserve the primary bounded failure when best-effort failure telemetry fails.
  }
}

function waitForHeartbeat(
  signal: AbortSignal,
  cadenceMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, cadenceMs);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function confirmHeartbeat(
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
  startedAt: number,
): Promise<void> {
  let owned: boolean;
  try {
    owned = await input.heartbeat();
  } catch {
    throw engineError("heartbeat_failed", input, state);
  }
  state.heartbeatCount += 1;
  if (!owned) {
    throw engineError("lease_lost", input, state);
  }
  emitLifecycle(input, state, startedAt, "heartbeat");
}

function abortPromise(signal: AbortSignal): {
  readonly promise: Promise<"aborted">;
  dispose(): void;
} {
  let listener: (() => void) | undefined;
  const promise = new Promise<"aborted">((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    listener = () => {
      return resolve("aborted");
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

async function abortMaintenanceSession(
  session: AgentSession,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): Promise<void> {
  try {
    await session.abort();
  } catch {
    throw engineError("session_failed", input, state);
  }
}

async function runMaintenancePrompt(args: {
  readonly session: AgentSession;
  readonly input: SnapshotPhase2Input;
  readonly state: Phase2RuntimeState;
  readonly startedAt: number;
  readonly testHooks: PiMemoryPhase2EngineTestHooks | undefined;
}): Promise<void> {
  await confirmHeartbeat(args.input, args.state, args.startedAt);
  args.input.signal.throwIfAborted();
  emitLifecycle(args.input, args.state, args.startedAt, "model_started");

  const completion = args.session
    .prompt("Consolidate the private Pi memory inputs now.", {
      expandPromptTemplates: false,
      source: "interactive",
    })
    .then(
      () => {
        return { status: "completed" as const };
      },
      () => {
        return { status: "failed" as const };
      },
    );
  const callerAbort = abortPromise(args.input.signal);
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([
    args.input.signal,
    heartbeatStop.signal,
  ]);
  const heartbeatLoop = (async () => {
    while (!heartbeatStop.signal.aborted) {
      try {
        await (args.testHooks?.waitForHeartbeat ?? waitForHeartbeat)(
          heartbeatSignal,
          PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
        );
      } catch {
        return {
          status: heartbeatStop.signal.aborted
            ? ("heartbeat_stopped" as const)
            : ("aborted" as const),
        };
      }
      try {
        await confirmHeartbeat(args.input, args.state, args.startedAt);
      } catch (error) {
        return { status: "heartbeat_failed" as const, error };
      }
    }
    return { status: "heartbeat_stopped" as const };
  })();
  try {
    const event = await Promise.race([
      completion,
      heartbeatLoop,
      callerAbort.promise.then(() => {
        return { status: "aborted" as const };
      }),
    ]);
    switch (event.status) {
      case "completed": {
        return;
      }
      case "failed": {
        throw engineError("model_failed", args.input, args.state);
      }
      case "aborted": {
        await abortMaintenanceSession(args.session, args.input, args.state);
        throw engineError("aborted", args.input, args.state);
      }
      case "heartbeat_failed": {
        await abortMaintenanceSession(args.session, args.input, args.state);
        throw event.error;
      }
      case "heartbeat_stopped": {
        throw engineError("session_failed", args.input, args.state);
      }
    }
  } finally {
    heartbeatStop.abort();
    callerAbort.dispose();
    await heartbeatLoop;
    await completion;
  }
}

function finalAssistantMessages(session: AgentSession): AssistantMessage[] {
  return session.agent.state.messages.flatMap((message) => {
    return message.role === "assistant" ? [message] : [];
  });
}

function providerResult(
  session: AgentSession,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): {
  readonly responseId: string;
  readonly usage: PiMemoryPhase2ProviderUsage;
} {
  const messages = finalAssistantMessages(session);
  const final = messages.at(-1);
  if (final?.stopReason === "error") {
    throw engineError("model_failed", input, state);
  }
  const hasCompletionText = final?.content.some((content) => {
    return content.type === "text" && content.text.trim().length > 0;
  });
  if (
    !final ||
    final.stopReason !== "stop" ||
    !hasCompletionText ||
    !final.responseId
  ) {
    throw engineError("session_failed", input, state);
  }
  const usage = messages.reduce<PiMemoryPhase2ProviderUsage>(
    (total, message) => {
      return {
        input: total.input + message.usage.input,
        output: total.output + message.usage.output,
        cacheRead: total.cacheRead + message.usage.cacheRead,
        cacheWrite: total.cacheWrite + message.usage.cacheWrite,
        reasoning: total.reasoning + (message.usage.reasoning ?? 0),
      };
    },
    ZERO_USAGE,
  );
  return { responseId: final.responseId, usage: Object.freeze(usage) };
}

async function createMaintenanceSession(args: {
  readonly input: SnapshotPhase2Input;
  readonly workspace: Phase2PrivateWorkspace;
  readonly prompt: string;
  readonly testHooks: PiMemoryPhase2EngineTestHooks | undefined;
}): Promise<AgentSession> {
  initializePiSessionResourceRegistry();
  const model = resolvePiAgentModel(args.input.model);
  if (!model) {
    throw new Phase2InputInvalidError();
  }
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    signal: args.input.signal,
  });
  modelRuntime.registerProvider(
    args.input.model.provider,
    registeredModelConfig(model, args.input),
  );
  const services = await createAgentSessionServices({
    cwd: PI_MEMORY_PHASE2_SESSION_CWD,
    agentDir: join(PI_MEMORY_PHASE2_SESSION_CWD, "agent"),
    modelRuntime,
    modelRuntimeSignal: args.input.signal,
    settingsManager: SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        retry: { enabled: false },
      },
      { projectTrusted: true },
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: args.prompt,
      skillsOverride: () => {
        return { skills: [], diagnostics: [] };
      },
      promptsOverride: () => {
        return { prompts: [], diagnostics: [] };
      },
      themesOverride: () => {
        return { themes: [], diagnostics: [] };
      },
      agentsFilesOverride: () => {
        return { agentsFiles: [] };
      },
      appendSystemPromptOverride: () => {
        return [];
      },
    },
  });
  const customTools = createPiMemoryPhase2Tools({
    memoryRoot: args.workspace.memoryRoot,
    inputsRoot: args.workspace.inputsRoot,
    testHooks: args.testHooks?.tools,
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(PI_MEMORY_PHASE2_SESSION_CWD, {
      id: randomUUID(),
    }),
    model,
    thinkingLevel: PI_MEMORY_PHASE2_MAINTENANCE_REASONING,
    tools: [...PI_MEMORY_PHASE2_TOOL_NAMES],
    customTools,
  });
  const resources = created.session.resourceLoader;
  const expectedSystemPrompt = `${args.prompt}\nCurrent working directory: ${PI_MEMORY_PHASE2_SESSION_CWD}`;
  if (created.session.systemPrompt !== expectedSystemPrompt) {
    created.session.dispose();
    throw new Error("Phase 2 session system prompt mismatch");
  }
  const systemPromptDigest = createHash("sha256")
    .update(created.session.systemPrompt, "utf8")
    .digest("hex");
  args.testHooks?.onSessionCreated?.({
    toolNames: created.session.agent.state.tools.map((tool) => {
      return tool.name;
    }),
    thinkingLevel: created.session.thinkingLevel,
    sessionFile: created.session.sessionFile,
    extensions: resources.getExtensions().extensions.length,
    skills: resources.getSkills().skills.length,
    prompts: resources.getPrompts().prompts.length,
    themes: resources.getThemes().themes.length,
    agentsFiles: resources.getAgentsFiles().agentsFiles.length,
    appendSystemPrompts: resources.getAppendSystemPrompt().length,
    systemPromptDigest,
  });
  return created.session;
}

function normalizeFailure(
  error: unknown,
  input: SnapshotPhase2Input | null,
  state: Phase2RuntimeState,
  signal: AbortSignal,
): PiMemoryPhase2EngineError {
  if (error instanceof PiMemoryPhase2EngineError) {
    return error;
  }
  if (error instanceof Phase2InputInvalidError) {
    return engineError("input_invalid", input, state);
  }
  if (error instanceof Phase2OutputInvalidError) {
    return engineError("agent_output_invalid", input, state);
  }
  if (input === null) {
    return engineError("input_invalid", input, state);
  }
  if (signal?.aborted) {
    return engineError("aborted", input, state);
  }
  return engineError("session_failed", input, state);
}

async function executeConsolidation(
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
  startedAt: number,
  root: string,
  testHooks: PiMemoryPhase2EngineTestHooks | undefined,
  signal: AbortSignal,
): Promise<PiMemoryPhase2ConsolidationResult> {
  signal.throwIfAborted();
  let prompt: string;
  try {
    prompt = renderPiMemoryPhase2Prompt();
  } catch {
    throw engineError("prompt_invariant", input, state);
  }
  const workspace = await createPiMemoryPhase2Workspace(root, input);
  state.fileCount = workspace.agentBaseline.size;
  state.totalBytes = [...workspace.agentBaseline.values()].reduce(
    (sum, content) => {
      return sum + content.length;
    },
    0,
  );
  emitLifecycle(input, state, startedAt, "staged");

  if (
    mapsEqual(workspace.base, workspace.agentBaseline) &&
    baseHasValidConsolidatedArtifacts(workspace.base)
  ) {
    const prepared = preparedSetFromSnapshot(
      input.memoryStorageId,
      workspace.base,
    );
    emitLifecycle(input, state, startedAt, "no_diff", {
      outcome: "no_diff",
      contentIdentity: prepared.contentIdentity,
    });
    return Object.freeze({
      status: "no_diff",
      ...prepared,
      diff: workspace.diff,
      selectionDigest: input.selectionDigest,
      responseId: null,
      usage: ZERO_USAGE,
    });
  }

  let session: AgentSession;
  try {
    session = await createMaintenanceSession({
      input,
      workspace,
      prompt,
      testHooks,
    });
  } catch (error) {
    if (error instanceof Phase2InputInvalidError) {
      throw error;
    }
    throw engineError("session_failed", input, state);
  }
  try {
    await runMaintenancePrompt({
      session,
      input,
      state,
      startedAt,
      testHooks,
    });
    const provider = providerResult(session, input, state);
    emitLifecycle(input, state, startedAt, "model_completed");
    await testHooks?.beforeOutputValidation?.(workspace);
    const prepared = await validatePiMemoryPhase2Output(
      workspace,
      input.memoryStorageId,
    );
    state.fileCount = prepared.manifest.fileCount;
    state.totalBytes = prepared.manifest.totalBytes;
    emitLifecycle(input, state, startedAt, "validated", {
      outcome: "prepared",
      contentIdentity: prepared.contentIdentity,
    });
    try {
      input.onUsage?.({
        orgId: input.orgId,
        userId: input.userId,
        memoryStorageId: input.memoryStorageId,
        claimedRevision: input.claimedRevision,
        selectionDigest: input.selectionDigest,
        responseId: provider.responseId,
        usage: provider.usage,
      });
    } catch {
      throw engineError("observer_failed", input, state);
    }
    return Object.freeze({
      status: "prepared",
      ...prepared,
      diff: workspace.diff,
      selectionDigest: input.selectionDigest,
      responseId: provider.responseId,
      usage: provider.usage,
    });
  } finally {
    session.dispose();
  }
}

export async function runPiMemoryPhase2ConsolidationForTest(
  args: PiMemoryPhase2ConsolidationArgs,
  testHooks: PiMemoryPhase2EngineTestHooks | undefined,
  signal: AbortSignal,
): Promise<PiMemoryPhase2ConsolidationResult> {
  const startedAt = performance.now();
  const state: Phase2RuntimeState = {
    heartbeatCount: 0,
    fileCount: 0,
    totalBytes: 0,
  };
  let input: SnapshotPhase2Input | null = null;
  let root: string | null = null;
  let result: PiMemoryPhase2ConsolidationResult | undefined;
  let failure: PiMemoryPhase2EngineError | undefined;
  try {
    input = snapshotPiMemoryPhase2Input(args, signal);
    state.fileCount = input.baseFiles.length;
    state.totalBytes = input.baseTotalBytes;
    signal.throwIfAborted();
    root = await mkdtemp(join(tmpdir(), "pi-memory-phase2-"));
    result = await executeConsolidation(
      input,
      state,
      startedAt,
      root,
      testHooks,
      signal,
    );
  } catch (error) {
    failure = normalizeFailure(error, input, state, signal);
  }

  if (root !== null) {
    let cleanupHookFailed = false;
    try {
      await testHooks?.beforeCleanup?.(root);
    } catch {
      cleanupHookFailed = true;
    }
    try {
      await removePiMemoryPhase2Workspace(root);
    } catch {
      cleanupHookFailed = true;
    }
    if (cleanupHookFailed) {
      failure = engineError("cleanup_failed", input, state);
    }
  }

  if (failure) {
    emitFailure(input, state, startedAt, failure);
    throw failure;
  }
  if (!result) {
    const missing = engineError("session_failed", input, state);
    emitFailure(input, state, startedAt, missing);
    throw missing;
  }
  return result;
}

/**
 * Prepare one immutable Pi memory Phase 2 artifact without publishing Storage
 * state or marking the claimed database job complete.
 */
export async function runPiMemoryPhase2Consolidation(
  args: PiMemoryPhase2ConsolidationArgs,
  signal: AbortSignal,
): Promise<PiMemoryPhase2ConsolidationResult> {
  return await runPiMemoryPhase2ConsolidationForTest(args, undefined, signal);
}
