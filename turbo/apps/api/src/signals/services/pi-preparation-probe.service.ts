import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  PiPreparationProbeProfile,
  PiPreparationProbeResponse,
} from "@okouai/api-contracts/contracts/test-pi-preparation-probe";
import {
  CANONICAL_PI_SESSION_DIR,
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
} from "@okouai/api-contracts/contracts/runners";
import {
  createPiNativeSessionFixture,
  measurePiOfficialPreparation,
  type PiOfficialPreparationProbeResult,
} from "@okouai/pi-agent-runtime/node";
import { create as createTar, extract as extractTar } from "tar";

import { singleton } from "../../lib/singleton";
import { onRejection } from "../utils";

const REPRESENTATIVE_SKILL_COUNT = 125;
const REPRESENTATIVE_SKILL_FILE_COUNT = 206;
const REPRESENTATIVE_SKILL_MD_BYTES = 1_160_041;
const REPRESENTATIVE_SKILL_TREE_BYTES = 2_497_082;
const PROBE_SESSION_ID = "9e7abfc3-e40e-4ae5-87ce-16b45c9f7860";
interface ProbeProfileConfig {
  readonly agentsBytes: number;
  readonly memoryBytes: number;
  readonly sessionTargetBytes: number;
  readonly skillCount: number;
  readonly skillFileCount: number;
  readonly skillMdBytes: number;
  readonly skillTreeBytes: number;
}

interface PreparedFixture {
  readonly archiveBytes: number;
  readonly archivePath: string;
  readonly buildMs: number;
  readonly config: ProbeProfileConfig;
  readonly root: string;
  readonly sessionBytes: number;
  readonly sessionPath: string;
}

interface FixtureResolution {
  readonly cacheHit: boolean;
  readonly disposable: boolean;
  readonly fixture: PreparedFixture;
}

interface ProbeInstanceState {
  readonly fixtureCache: Map<
    PiPreparationProbeProfile,
    Promise<PreparedFixture>
  >;
  readonly instanceId: string;
}

const probeInstanceState = singleton((): ProbeInstanceState => {
  return {
    fixtureCache: new Map(),
    instanceId: randomUUID(),
  };
});

function profileConfig(profile: PiPreparationProbeProfile): ProbeProfileConfig {
  const representative = {
    agentsBytes: 64 * 1024,
    memoryBytes: 256 * 1024,
    sessionTargetBytes: 4 * 1024 * 1024,
    skillCount: REPRESENTATIVE_SKILL_COUNT,
    skillFileCount: REPRESENTATIVE_SKILL_FILE_COUNT,
    skillMdBytes: REPRESENTATIVE_SKILL_MD_BYTES,
    skillTreeBytes: REPRESENTATIVE_SKILL_TREE_BYTES,
  } satisfies ProbeProfileConfig;
  switch (profile) {
    case "minimal": {
      return {
        agentsBytes: 16 * 1024,
        memoryBytes: 32 * 1024,
        sessionTargetBytes: 64 * 1024,
        skillCount: 4,
        skillFileCount: 8,
        skillMdBytes: 32 * 1024,
        skillTreeBytes: 128 * 1024,
      };
    }
    case "representative": {
      return representative;
    }
    case "session-16-mib": {
      return { ...representative, sessionTargetBytes: 16 * 1024 * 1024 };
    }
    case "session-64-mib": {
      return { ...representative, sessionTargetBytes: 64 * 1024 * 1024 };
    }
    case "assets-32-mib": {
      return { ...representative, skillTreeBytes: 32 * 1024 * 1024 };
    }
  }
}

function splitBytes(total: number, count: number, index: number): number {
  const base = Math.floor(total / count);
  return base + (index < total % count ? 1 : 0);
}

function paddedText(base: string, targetBytes: number): Buffer {
  const baseBytes = Buffer.byteLength(base);
  if (baseBytes > targetBytes) {
    throw new Error("Pi preparation probe text target is too small");
  }
  return Buffer.from(`${base}${"p".repeat(targetBytes - baseBytes)}`);
}

function deterministicBytes(length: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let state = (seed + 1) * 2_654_435_761;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[index] = state & 0xff;
  }
  return buffer;
}

async function writeFixtureFile(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function relativePhysicalPath(canonicalPath: string): string {
  return canonicalPath.replace(/^\//u, "");
}

async function writeSkillTree(
  sourceRoot: string,
  config: ProbeProfileConfig,
): Promise<void> {
  const skillsRoot = join(
    sourceRoot,
    relativePhysicalPath(PI_AGENT_DIR),
    "skills",
  );
  const assetFileCount = config.skillFileCount - config.skillCount;
  const assetBytes = config.skillTreeBytes - config.skillMdBytes;
  const writes: Promise<void>[] = [];
  for (let index = 0; index < config.skillCount; index += 1) {
    const name = `probe-skill-${index.toString().padStart(3, "0")}`;
    const base = `---\nname: ${name}\ndescription: Synthetic preparation probe skill ${index}.\n---\n\n# ${name}\n\n`;
    writes.push(
      writeFixtureFile(
        join(skillsRoot, name, "SKILL.md"),
        paddedText(
          base,
          splitBytes(config.skillMdBytes, config.skillCount, index),
        ),
      ),
    );
  }
  for (let index = 0; index < assetFileCount; index += 1) {
    const skillIndex = index % config.skillCount;
    const skillName = `probe-skill-${skillIndex.toString().padStart(3, "0")}`;
    writes.push(
      writeFixtureFile(
        join(
          skillsRoot,
          skillName,
          "references",
          `asset-${index.toString().padStart(3, "0")}.bin`,
        ),
        deterministicBytes(
          splitBytes(assetBytes, assetFileCount, index),
          index,
        ),
      ),
    );
  }
  await Promise.all(writes);
}

async function writeContextAndMemory(
  sourceRoot: string,
  config: ProbeProfileConfig,
): Promise<void> {
  const globalAgentsBytes = Math.floor(config.agentsBytes / 2);
  const projectAgentsBytes = config.agentsBytes - globalAgentsBytes;
  await Promise.all([
    writeFixtureFile(
      join(sourceRoot, relativePhysicalPath(PI_AGENT_DIR), "AGENTS.md"),
      paddedText(
        "# Global preparation probe instructions\n\n",
        globalAgentsBytes,
      ),
    ),
    writeFixtureFile(
      join(
        sourceRoot,
        relativePhysicalPath(CANONICAL_WORKING_DIR),
        "AGENTS.md",
      ),
      paddedText(
        "# Project preparation probe instructions\n\n",
        projectAgentsBytes,
      ),
    ),
    writeFixtureFile(
      join(
        sourceRoot,
        relativePhysicalPath(PI_AGENT_DIR),
        "memory",
        "MEMORY.md",
      ),
      paddedText("# Preparation probe memory\n\n", config.memoryBytes),
    ),
  ]);
}

async function buildFixture(
  profile: PiPreparationProbeProfile,
): Promise<PreparedFixture> {
  const startedAt = performance.now();
  const config = profileConfig(profile);
  const root = await mkdtemp(join(tmpdir(), `pi-prep-fixture-${profile}-`));
  const sourceRoot = join(root, "source");
  await Promise.all([
    writeSkillTree(sourceRoot, config),
    writeContextAndMemory(sourceRoot, config),
  ]);

  const archivePath = join(root, "resources.tar.gz");
  await createTar(
    {
      cwd: sourceRoot,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    ["home"],
  );
  await rm(sourceRoot, { force: true, recursive: true });

  const sessionPath = join(root, "session.jsonl");
  const sessionFixture = createPiNativeSessionFixture({
    logicalCwd: CANONICAL_WORKING_DIR,
    sessionId: PROBE_SESSION_ID,
    targetBytes: config.sessionTargetBytes,
  });
  await writeFile(sessionPath, sessionFixture);
  const [archiveStats, sessionStats] = await Promise.all([
    stat(archivePath),
    stat(sessionPath),
  ]);
  return {
    archiveBytes: archiveStats.size,
    archivePath,
    buildMs: performance.now() - startedAt,
    config,
    root,
    sessionBytes: sessionStats.size,
    sessionPath,
  };
}

async function resolveFixture(
  profile: PiPreparationProbeProfile,
  rebuild: boolean,
): Promise<FixtureResolution> {
  if (rebuild) {
    return {
      cacheHit: false,
      disposable: true,
      fixture: await buildFixture(profile),
    };
  }
  const cache = probeInstanceState().fixtureCache;
  const cached = cache.get(profile);
  if (cached) {
    return { cacheHit: true, disposable: false, fixture: await cached };
  }
  const pending = buildFixture(profile);
  cache.set(profile, pending);
  const fixture = await onRejection(pending, () => {
    cache.delete(profile);
  });
  return { cacheHit: false, disposable: false, fixture };
}

function officialResponse(
  result: PiOfficialPreparationProbeResult,
): PiPreparationProbeResponse["samples"][number]["official"] {
  return {
    agent_session_create_ms: result.agentSessionCreateMs,
    agents_file_count: result.agentsFileCount,
    diagnostic_count: result.diagnosticCount,
    discovered_skill_count: result.discoveredSkillCount,
    model_runtime_create_ms: result.modelRuntimeCreateMs,
    session_entry_count: result.sessionEntryCount,
    session_header_cwd: result.sessionHeaderCwd,
    session_list_ms: result.sessionListMs,
    session_open_ms: result.sessionOpenMs,
    session_persisted: result.sessionPersisted,
    session_services_create_ms: result.sessionServicesCreateMs,
    settings_manager_create_ms: result.settingsManagerCreateMs,
    total_ms: result.totalMs,
  };
}

function currentRss(): number {
  return process.memoryUsage().rss;
}

async function runPreparationSample(
  fixture: PreparedFixture,
  signal: AbortSignal,
): Promise<PiPreparationProbeResponse["samples"][number]> {
  const totalStartedAt = performance.now();
  let peakRss = currentRss();
  const updatePeakRss = () => {
    peakRss = Math.max(peakRss, currentRss());
  };

  const leaseStartedAt = performance.now();
  const leaseRoot = await mkdtemp(join(tmpdir(), "pi-prep-run-"));
  const leaseCreateMs = performance.now() - leaseStartedAt;

  const sample = (async () => {
    const archiveExtractStartedAt = performance.now();
    await extractTar({
      cwd: leaseRoot,
      file: fixture.archivePath,
      strict: true,
    });
    const archiveExtractMs = performance.now() - archiveExtractStartedAt;
    updatePeakRss();
    signal.throwIfAborted();

    const agentDir = join(leaseRoot, relativePhysicalPath(PI_AGENT_DIR));
    const cwd = join(leaseRoot, relativePhysicalPath(CANONICAL_WORKING_DIR));
    const sessionDir = join(
      leaseRoot,
      relativePhysicalPath(CANONICAL_PI_SESSION_DIR),
    );
    await mkdir(sessionDir, { recursive: true });
    const restoredSessionPath = join(
      sessionDir,
      `2026-08-19T00-00-00-000Z_${PROBE_SESSION_ID}.jsonl`,
    );
    const sessionWriteStartedAt = performance.now();
    await copyFile(fixture.sessionPath, restoredSessionPath);
    const sessionWriteMs = performance.now() - sessionWriteStartedAt;
    updatePeakRss();
    signal.throwIfAborted();

    const official = await measurePiOfficialPreparation({
      agentDir,
      cwd,
      logicalCwd: CANONICAL_WORKING_DIR,
      sessionDir,
      sessionId: PROBE_SESSION_ID,
    });
    updatePeakRss();
    signal.throwIfAborted();
    const preparationMs = performance.now() - totalStartedAt;

    const checkpointReadStartedAt = performance.now();
    const checkpoint = await readFile(restoredSessionPath);
    const checkpointReadMs = performance.now() - checkpointReadStartedAt;
    updatePeakRss();

    const cleanupStartedAt = performance.now();
    await rm(leaseRoot, { force: true, recursive: true });
    const cleanupMs = performance.now() - cleanupStartedAt;
    return {
      archive_extract_ms: archiveExtractMs,
      checkpoint_bytes: checkpoint.length,
      checkpoint_read_ms: checkpointReadMs,
      cleanup_ms: cleanupMs,
      lease_create_ms: leaseCreateMs,
      official: officialResponse(official),
      peak_rss_bytes: peakRss,
      preparation_ms: preparationMs,
      session_write_ms: sessionWriteMs,
      total_ms: performance.now() - totalStartedAt,
    };
  })();
  return await onRejection(sample, async () => {
    await rm(leaseRoot, { force: true, recursive: true });
  });
}

export async function runPiPreparationProbe(
  args: {
    readonly iterations: number;
    readonly profile: PiPreparationProbeProfile;
    readonly rebuildFixture: boolean;
    readonly region: string | null;
  },
  signal: AbortSignal,
): Promise<PiPreparationProbeResponse> {
  const rssBytesBefore = currentRss();
  const resolution = await resolveFixture(args.profile, args.rebuildFixture);
  const execution = (async (): Promise<
    PiPreparationProbeResponse["samples"]
  > => {
    const samples: PiPreparationProbeResponse["samples"] = [];
    for (let index = 0; index < args.iterations; index += 1) {
      signal.throwIfAborted();
      samples.push(await runPreparationSample(resolution.fixture, signal));
    }
    return samples;
  })();
  const samples = await onRejection(execution, async () => {
    if (resolution.disposable) {
      await rm(resolution.fixture.root, { force: true, recursive: true });
    }
  });
  if (resolution.disposable) {
    await rm(resolution.fixture.root, { force: true, recursive: true });
  }
  const config = resolution.fixture.config;
  return {
    ok: true,
    fixture: {
      agents_bytes: config.agentsBytes,
      archive_bytes: resolution.fixture.archiveBytes,
      build_ms: resolution.fixture.buildMs,
      cache_hit: resolution.cacheHit,
      expected_skill_count: config.skillCount,
      memory_bytes: config.memoryBytes,
      session_bytes: resolution.fixture.sessionBytes,
      skill_file_count: config.skillFileCount,
      skill_md_bytes: config.skillMdBytes,
      skill_tree_bytes: config.skillTreeBytes,
    },
    measurement_limits: [
      "Storage and R2 network download is excluded from timed preparation.",
      "The representative file counts and byte totals match the current installed skill tree, but file contents are synthetic.",
      "No model request, executable extension, or agent tool is invoked.",
      "The probe initializes Pi's session resource registry through its core entrypoint before disposing a no-model AgentSession.",
    ],
    network_download_measured: false,
    profile: args.profile,
    runtime: {
      arch: process.arch,
      instance_id: probeInstanceState().instanceId,
      node_version: process.version,
      platform: process.platform,
      process_uptime_ms: process.uptime() * 1000,
      region: args.region,
      rss_bytes_after: currentRss(),
      rss_bytes_before: rssBytesBefore,
      tmp_dir: tmpdir(),
    },
    samples,
  };
}
