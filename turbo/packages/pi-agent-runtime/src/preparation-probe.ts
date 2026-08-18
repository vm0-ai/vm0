import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";

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

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
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
