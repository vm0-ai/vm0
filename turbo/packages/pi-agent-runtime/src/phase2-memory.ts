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
  applyValidatedPiMemoryPhase2Result,
  createPiMemoryPhase2Workspace,
  mapsEqual,
  Phase2InputInvalidError,
  Phase2OutputInvalidError,
  preparedSetFromSnapshot,
  removePiMemoryPhase2Workspace,
  snapshotPiMemoryPhase2Input,
  snapshotMountedPiMemoryPhase2Base,
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

interface Phase2ProviderResult {
  readonly responseId: string;
  readonly usage: PiMemoryPhase2ProviderUsage;
}

type Phase2ModelTerminal = Readonly<{
  source: "model";
  status: "completed" | "failed";
}>;

type Phase2HeartbeatTerminal =
  | Readonly<{ source: "heartbeat"; status: "stopped" | "aborted" }>
  | Readonly<{ source: "heartbeat"; status: "failed"; error: unknown }>;

type Phase2CallerTerminal = Readonly<{
  source: "caller";
  status: "aborted" | "disposed";
}>;

type Phase2Terminal =
  | Phase2ModelTerminal
  | Phase2HeartbeatTerminal
  | Phase2CallerTerminal;

interface Phase2TerminalSettlement {
  readonly model: Phase2ModelTerminal;
  readonly heartbeat: Phase2HeartbeatTerminal;
  readonly caller: Phase2CallerTerminal;
}

interface Phase2TerminalArbiter {
  readonly selected: Promise<Phase2Terminal>;
  settle(): Promise<Phase2TerminalSettlement>;
}

interface Phase2CapturedFailure {
  readonly error: unknown;
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
  readonly afterModelCompletionSelected?: () => Promise<void>;
  readonly onSessionDisposed?: () => void;
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
  readonly promise: Promise<"aborted" | "disposed">;
  dispose(): void;
} {
  let listener: (() => void) | undefined;
  let resolvePromise: ((status: "aborted" | "disposed") => void) | undefined;
  let settled = false;
  const promise = new Promise<"aborted" | "disposed">((resolve) => {
    resolvePromise = resolve;
    if (signal.aborted) {
      settled = true;
      resolve("aborted");
      return;
    }
    listener = () => {
      settled = true;
      resolve("aborted");
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) {
        signal.removeEventListener("abort", listener);
      }
      if (!settled) {
        settled = true;
        resolvePromise?.("disposed");
      }
    },
  };
}

function createTerminalArbiter(args: {
  readonly session: AgentSession;
  readonly input: SnapshotPhase2Input;
  readonly state: Phase2RuntimeState;
  readonly startedAt: number;
  readonly testHooks: PiMemoryPhase2EngineTestHooks | undefined;
}): Phase2TerminalArbiter {
  const model = args.session
    .prompt("Consolidate the private Pi memory inputs now.", {
      expandPromptTemplates: false,
      source: "interactive",
    })
    .then(
      (): Phase2ModelTerminal => {
        return { source: "model", status: "completed" };
      },
      (): Phase2ModelTerminal => {
        return { source: "model", status: "failed" };
      },
    );
  const callerAbort = abortPromise(args.input.signal);
  const caller = callerAbort.promise.then<Phase2CallerTerminal>((status) => {
    return { source: "caller", status };
  });
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([
    args.input.signal,
    heartbeatStop.signal,
  ]);
  const heartbeat = (async (): Promise<Phase2HeartbeatTerminal> => {
    while (!heartbeatStop.signal.aborted) {
      try {
        await (args.testHooks?.waitForHeartbeat ?? waitForHeartbeat)(
          heartbeatSignal,
          PI_MEMORY_PHASE2_EXPECTED_HEARTBEAT_CADENCE_MS,
        );
      } catch {
        return {
          source: "heartbeat",
          status: heartbeatStop.signal.aborted ? "stopped" : "aborted",
        };
      }
      try {
        await confirmHeartbeat(args.input, args.state, args.startedAt);
      } catch (error) {
        return { source: "heartbeat", status: "failed", error };
      }
    }
    return { source: "heartbeat", status: "stopped" };
  })();
  return {
    selected: Promise.race([model, heartbeat, caller]),
    async settle() {
      heartbeatStop.abort();
      callerAbort.dispose();
      const [modelResult, heartbeatResult, callerResult] = await Promise.all([
        model,
        heartbeat,
        caller,
      ]);
      return {
        model: modelResult,
        heartbeat: heartbeatResult,
        caller: callerResult,
      };
    },
  };
}

function terminalFailure(
  terminal: Phase2Terminal,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): Phase2CapturedFailure | undefined {
  switch (terminal.source) {
    case "model": {
      return terminal.status === "failed"
        ? { error: engineError("model_failed", input, state) }
        : undefined;
    }
    case "heartbeat": {
      if (terminal.status === "failed") {
        return { error: terminal.error };
      }
      return {
        error: engineError(
          terminal.status === "aborted" ? "aborted" : "session_failed",
          input,
          state,
        ),
      };
    }
    case "caller": {
      return {
        error: engineError(
          terminal.status === "aborted" ? "aborted" : "session_failed",
          input,
          state,
        ),
      };
    }
  }
}

function settlementFailure(
  settlement: Phase2TerminalSettlement,
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
): Phase2CapturedFailure | undefined {
  if (settlement.heartbeat.status === "failed") {
    return { error: settlement.heartbeat.error };
  }
  if (
    settlement.heartbeat.status === "aborted" ||
    settlement.caller.status === "aborted"
  ) {
    return { error: engineError("aborted", input, state) };
  }
  if (settlement.model.status === "failed") {
    return { error: engineError("model_failed", input, state) };
  }
  return undefined;
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
}): Promise<Phase2ProviderResult> {
  let arbiter: Phase2TerminalArbiter | undefined;
  let failure: Phase2CapturedFailure | undefined;
  let provider: Phase2ProviderResult | undefined;
  try {
    await confirmHeartbeat(args.input, args.state, args.startedAt);
    args.input.signal.throwIfAborted();
    emitLifecycle(args.input, args.state, args.startedAt, "model_started");
    args.input.signal.throwIfAborted();
    arbiter = createTerminalArbiter(args);
    const terminal = await arbiter.selected;
    failure = args.input.signal.aborted
      ? { error: engineError("aborted", args.input, args.state) }
      : terminalFailure(terminal, args.input, args.state);
    if (!failure) {
      await args.testHooks?.afterModelCompletionSelected?.();
      args.input.signal.throwIfAborted();
      provider = providerResult(args.session, args.input, args.state);
    }
  } catch (error) {
    failure = { error };
  }

  if (failure && arbiter) {
    try {
      await abortMaintenanceSession(args.session, args.input, args.state);
    } catch (error) {
      failure = { error };
    }
  }
  args.session.dispose();
  const settlement = arbiter ? await arbiter.settle() : undefined;
  args.testHooks?.onSessionDisposed?.();

  if (!failure && settlement) {
    failure = settlementFailure(settlement, args.input, args.state);
  }

  if (failure) {
    throw failure.error;
  }
  args.input.signal.throwIfAborted();
  if (!provider) {
    throw engineError("session_failed", args.input, args.state);
  }
  return provider;
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
): Phase2ProviderResult {
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
  signal.throwIfAborted();

  if (
    mapsEqual(workspace.base, workspace.agentBaseline) &&
    baseHasValidConsolidatedArtifacts(workspace.base)
  ) {
    const prepared = preparedSetFromSnapshot(
      input.memoryStorageId,
      workspace.base,
    );
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    if (error instanceof Phase2InputInvalidError) {
      throw error;
    }
    throw engineError("session_failed", input, state);
  }
  const provider = await runMaintenancePrompt({
    session,
    input,
    state,
    startedAt,
    testHooks,
  });
  emitLifecycle(input, state, startedAt, "model_completed");
  try {
    await input.onUsage?.({
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
  signal.throwIfAborted();
  await testHooks?.beforeOutputValidation?.(workspace);
  signal.throwIfAborted();
  let prepared: Awaited<ReturnType<typeof validatePiMemoryPhase2Output>>;
  try {
    prepared = await validatePiMemoryPhase2Output(
      workspace,
      input.memoryStorageId,
    );
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
  signal.throwIfAborted();
  state.fileCount = prepared.manifest.fileCount;
  state.totalBytes = prepared.manifest.totalBytes;
  return Object.freeze({
    status: "prepared",
    ...prepared,
    diff: workspace.diff,
    selectionDigest: input.selectionDigest,
    responseId: provider.responseId,
    usage: provider.usage,
  });
}

function commitConsolidationResult(
  input: SnapshotPhase2Input,
  state: Phase2RuntimeState,
  startedAt: number,
  result: PiMemoryPhase2ConsolidationResult,
  signal: AbortSignal,
): PiMemoryPhase2ConsolidationResult {
  signal.throwIfAborted();
  if (result.status === "no_diff") {
    emitLifecycle(input, state, startedAt, "no_diff", {
      outcome: "no_diff",
      contentIdentity: result.contentIdentity,
    });
    signal.throwIfAborted();
    return result;
  }

  emitLifecycle(input, state, startedAt, "validated", {
    outcome: "prepared",
    contentIdentity: result.contentIdentity,
  });
  signal.throwIfAborted();
  return result;
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

  if (!failure && result && input) {
    try {
      result = commitConsolidationResult(
        input,
        state,
        startedAt,
        result,
        signal,
      );
    } catch (error) {
      failure = normalizeFailure(error, input, state, signal);
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

export interface PiMemoryPhase2MountedConsolidationArgs {
  readonly memoryRoot: string;
  readonly memoryStorageId: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly leaseToken: string;
  readonly selectionDigest: string;
  readonly selected: readonly PiMemoryPhase2ConsolidationArgs["selected"][number][];
  readonly model: PiMemoryPhase2ConsolidationArgs["model"];
}

/**
 * Run Phase 2 from the exact mounted Storage epoch and apply only a fully
 * validated result back to that mount. Durable publication remains owned by
 * the ordinary terminal artifact checkpoint.
 */
export async function runPiMemoryPhase2MountedConsolidation(
  args: PiMemoryPhase2MountedConsolidationArgs,
  signal: AbortSignal,
): Promise<{
  readonly status: "no_diff" | "prepared";
  readonly validatedVersionId: string;
}> {
  const baseFiles = await snapshotMountedPiMemoryPhase2Base(args.memoryRoot);
  const mountedBaseVersionId = createHash("sha256")
    .update(
      `storage:${args.memoryStorageId}\n${baseFiles
        .map((file) => {
          return `${file.path}:${file.hash}`;
        })
        .sort()
        .join("\n")}`,
    )
    .digest("hex");
  if (mountedBaseVersionId !== args.claimedBaseVersionId) {
    throw new PiMemoryPhase2EngineError("input_invalid", {
      candidateCount: args.selected.length,
      fileCount: baseFiles.length,
      totalBytes: baseFiles.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      heartbeatCount: 0,
    });
  }
  const result = await runPiMemoryPhase2Consolidation(
    {
      orgId: "sandbox",
      userId: "sandbox",
      memoryStorageId: args.memoryStorageId,
      claimedRevision: args.claimedRevision,
      leaseToken: args.leaseToken,
      baseFiles,
      selected: args.selected,
      model: args.model,
      heartbeat: async () => {
        return true;
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.selectionDigest !== args.selectionDigest) {
    throw new PiMemoryPhase2EngineError("input_invalid", {
      candidateCount: args.selected.length,
      fileCount: baseFiles.length,
      totalBytes: baseFiles.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      heartbeatCount: 0,
    });
  }
  try {
    await applyValidatedPiMemoryPhase2Result({
      memoryRoot: args.memoryRoot,
      memoryStorageId: args.memoryStorageId,
      baseFiles,
      files: result.files,
      contentIdentity: result.contentIdentity,
    });
  } catch {
    throw new PiMemoryPhase2EngineError("agent_output_invalid", {
      candidateCount: args.selected.length,
      fileCount: result.manifest.fileCount,
      totalBytes: result.manifest.totalBytes,
      heartbeatCount: 0,
    });
  }
  signal.throwIfAborted();
  return {
    status: result.status,
    validatedVersionId: result.contentIdentity,
  };
}
