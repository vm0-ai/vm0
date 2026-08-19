import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createReadToolDefinition,
  migrateSessionEntries,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
  SettingsManager,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";

import {
  PiMemoryFileStore,
  PiMemoryResourceLoader,
  type PiMemoryFileInput,
  type PiMemoryResourceSnapshot,
} from "./memory-resource-loader";

export interface PiOfficialPreparationProbeInput {
  readonly agentDir: string;
  readonly cwd: string;
  readonly logicalCwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
}

export interface PiOfficialPreparationProbeResult {
  readonly agentSessionCreateMs: number;
  readonly agentsFileCount: number;
  readonly diagnosticCount: number;
  readonly discoveredSkillCount: number;
  readonly modelRuntimeCreateMs: number;
  readonly sessionEntryCount: number;
  readonly sessionHeaderCwd: string | null;
  readonly sessionListMs: number;
  readonly sessionOpenMs: number;
  readonly sessionPersisted: boolean;
  readonly sessionServicesCreateMs: number;
  readonly settingsManagerCreateMs: number;
  readonly totalMs: number;
}

export interface PiNativeSessionFixtureInput {
  readonly logicalCwd: string;
  readonly sessionId: string;
  readonly targetBytes: number;
}

export interface PiMemoryPreparationProbeInput {
  readonly agentDir: string;
  readonly cwd: string;
  readonly files: readonly PiMemoryFileInput[];
  readonly logicalCwd: string;
  readonly resources: PiMemoryResourceSnapshot;
  readonly sessionId: string;
  readonly sessionJsonl: Uint8Array;
}

export interface PiMemoryPreparationProbeResult {
  readonly checkpoint: Buffer;
  readonly checkpointMaterializeMs: number;
  readonly official: PiOfficialPreparationProbeResult;
  readonly preparationMs: number;
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

function serializePiSession(sessionManager: SessionManager): Buffer {
  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("Pi preparation probe session has no header");
  }
  return Buffer.from(
    `${[header, ...sessionManager.getEntries()]
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n")}\n`,
  );
}

/** Create a valid native Pi JSONL fixture without writing it to disk. */
export function createPiNativeSessionFixture(
  input: PiNativeSessionFixtureInput,
): Buffer {
  const sessionManager = SessionManager.inMemory(input.logicalCwd, {
    id: input.sessionId,
  });
  const chunk = "p".repeat(1024 * 1024);
  let payloadBytes = 0;
  while (payloadBytes < input.targetBytes) {
    const remaining = input.targetBytes - payloadBytes;
    const payload =
      remaining >= chunk.length ? chunk : chunk.slice(0, remaining);
    sessionManager.appendCustomEntry("preparation-probe-padding", payload);
    payloadBytes += payload.length;
  }
  const entries = [
    sessionManager.getHeader(),
    ...sessionManager.getEntries(),
  ].filter((entry) => {
    return entry !== null;
  });
  return Buffer.from(
    `${entries
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n")}\n`,
  );
}

interface SessionManagerProbeInternals {
  _buildIndex(): void;
  fileEntries: FileEntry[];
  flushed: boolean;
  sessionId: string;
}

/**
 * Preview-only bridge for measuring the API design against Pi 0.84.1.
 *
 * Pi already keeps preloaded entries internally, but its public in-memory
 * factory can only create an empty session. The production implementation must
 * use an upstream fromJSONL/fromEntries factory instead of reaching into these
 * private fields.
 */
function hydratePiSessionForMemoryProbe(
  sessionJsonl: Uint8Array,
  logicalCwd: string,
  expectedSessionId: string,
): SessionManager {
  const jsonlBuffer = Buffer.isBuffer(sessionJsonl)
    ? sessionJsonl
    : Buffer.from(
        sessionJsonl.buffer as ArrayBuffer,
        sessionJsonl.byteOffset,
        sessionJsonl.byteLength,
      );
  const entries = parseSessionEntries(jsonlBuffer.toString("utf8"));
  migrateSessionEntries(entries);
  const header = entries[0];
  if (header?.type !== "session") {
    throw new Error("Pi preparation probe JSONL has no native session header");
  }
  if (header.id !== expectedSessionId) {
    throw new Error(
      `Pi preparation probe expected session ${expectedSessionId}, received ${header.id}`,
    );
  }

  const sessionManager = SessionManager.inMemory(logicalCwd, {
    id: header.id,
  });
  const internals = sessionManager as unknown as SessionManagerProbeInternals;
  internals.fileEntries = entries;
  internals.sessionId = header.id;
  internals.flushed = true;
  internals._buildIndex();
  return sessionManager;
}

/**
 * Measure the official Pi service and session construction used by the API
 * preparation experiment. This never invokes a model or enables agent tools.
 */
export async function measurePiOfficialPreparation(
  input: PiOfficialPreparationProbeInput,
): Promise<PiOfficialPreparationProbeResult> {
  const totalStartedAt = performance.now();

  const modelRuntimeStartedAt = performance.now();
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const modelRuntimeCreateMs = elapsedMs(modelRuntimeStartedAt);

  const settingsManagerStartedAt = performance.now();
  const settingsManager = SettingsManager.create(input.cwd, input.agentDir, {
    projectTrusted: false,
  });
  const settingsManagerCreateMs = elapsedMs(settingsManagerStartedAt);

  const sessionServicesStartedAt = performance.now();
  const services = await createAgentSessionServices({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const sessionServicesCreateMs = elapsedMs(sessionServicesStartedAt);

  const sessionListStartedAt = performance.now();
  const sessionInfo = (
    await SessionManager.list(input.logicalCwd, input.sessionDir)
  ).find((candidate) => {
    return candidate.id === input.sessionId;
  });
  const sessionListMs = elapsedMs(sessionListStartedAt);
  if (!sessionInfo) {
    throw new Error(
      `Pi preparation probe session ${input.sessionId} is missing`,
    );
  }

  const sessionOpenStartedAt = performance.now();
  const sessionManager = SessionManager.open(
    sessionInfo.path,
    input.sessionDir,
    input.logicalCwd,
  );
  const sessionOpenMs = elapsedMs(sessionOpenStartedAt);

  const agentSessionStartedAt = performance.now();
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    noTools: "all",
  });
  const agentSessionCreateMs = elapsedMs(agentSessionStartedAt);

  const { agentsFiles } = services.resourceLoader.getAgentsFiles();
  const { skills } = services.resourceLoader.getSkills();
  const result: PiOfficialPreparationProbeResult = {
    agentSessionCreateMs,
    agentsFileCount: agentsFiles.length,
    diagnosticCount: services.diagnostics.length,
    discoveredSkillCount: skills.length,
    modelRuntimeCreateMs,
    sessionEntryCount: sessionManager.getEntries().length,
    sessionHeaderCwd: sessionManager.getHeader()?.cwd ?? null,
    sessionListMs,
    sessionOpenMs,
    sessionPersisted: sessionManager.isPersisted(),
    sessionServicesCreateMs,
    settingsManagerCreateMs,
    totalMs: elapsedMs(totalStartedAt),
  };
  // The Vite server bundle can retain cleanupSessionResources from Pi's
  // compatibility barrel without scheduling its module initializer. Register
  // a no-op through Pi's core entrypoint so dispose exercises the real cleanup
  // path with the registry initialized.
  const unregisterProbeResource = registerSessionResourceCleanup(() => {});
  await created.session.dispose();
  unregisterProbeResource();
  return result;
}

/**
 * Measure Pi construction from an already-prewarmed resource snapshot and
 * native JSONL bytes. No physical project, agent, or session path is created.
 */
export async function measurePiMemoryPreparation(
  input: PiMemoryPreparationProbeInput,
): Promise<PiMemoryPreparationProbeResult> {
  const totalStartedAt = performance.now();

  const modelRuntimeStartedAt = performance.now();
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const modelRuntimeCreateMs = elapsedMs(modelRuntimeStartedAt);

  const settingsManagerStartedAt = performance.now();
  const settingsManager = SettingsManager.inMemory();
  const settingsManagerCreateMs = elapsedMs(settingsManagerStartedAt);

  const sessionServicesStartedAt = performance.now();
  const fileStore = new PiMemoryFileStore(input.files);
  const resourceLoader = new PiMemoryResourceLoader(input.resources);
  const services = {
    agentDir: input.agentDir,
    cwd: input.cwd,
    diagnostics: [],
    modelRuntime,
    resourceLoader,
    settingsManager,
  };
  const memoryReadTool = createReadToolDefinition(input.cwd, {
    operations: fileStore.readOperations(),
  }) as unknown as ToolDefinition;
  const sessionServicesCreateMs = elapsedMs(sessionServicesStartedAt);

  const sessionOpenStartedAt = performance.now();
  const sessionManager = hydratePiSessionForMemoryProbe(
    input.sessionJsonl,
    input.logicalCwd,
    input.sessionId,
  );
  const sessionOpenMs = elapsedMs(sessionOpenStartedAt);

  const agentSessionStartedAt = performance.now();
  const created = await createAgentSessionFromServices({
    customTools: [memoryReadTool],
    services,
    sessionManager,
    tools: ["read"],
  });
  const agentSessionCreateMs = elapsedMs(agentSessionStartedAt);

  const { agentsFiles } = resourceLoader.getAgentsFiles();
  const { skills } = resourceLoader.getSkills();
  const firstSkill = skills[0];
  if (firstSkill && !fileStore.has(firstSkill.filePath)) {
    throw new Error(`Pi memory skill body is missing: ${firstSkill.filePath}`);
  }
  if (
    firstSkill &&
    !created.session.systemPrompt.includes(firstSkill.filePath)
  ) {
    throw new Error(
      "Pi did not project the memory skill into its system prompt",
    );
  }

  const official: PiOfficialPreparationProbeResult = {
    agentSessionCreateMs,
    agentsFileCount: agentsFiles.length,
    diagnosticCount: services.diagnostics.length,
    discoveredSkillCount: skills.length,
    modelRuntimeCreateMs,
    sessionEntryCount: sessionManager.getEntries().length,
    sessionHeaderCwd: sessionManager.getHeader()?.cwd ?? null,
    sessionListMs: 0,
    sessionOpenMs,
    sessionPersisted: sessionManager.isPersisted(),
    sessionServicesCreateMs,
    settingsManagerCreateMs,
    totalMs: elapsedMs(totalStartedAt),
  };

  const unregisterProbeResource = registerSessionResourceCleanup(() => {});
  await created.session.dispose();
  unregisterProbeResource();
  const preparationMs = elapsedMs(totalStartedAt);

  const checkpointStartedAt = performance.now();
  const checkpoint = serializePiSession(sessionManager);
  return {
    checkpoint,
    checkpointMaterializeMs: elapsedMs(checkpointStartedAt),
    official,
    preparationMs,
  };
}
