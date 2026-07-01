import { gzipSync } from "node:zlib";

import type { StorageManifest } from "@vm0/api-contracts/contracts/runners";
import { expandVariablesInString } from "@vm0/core/variable-expander";
import {
  getInstructionsFilename,
  type SupportedFramework,
} from "@vm0/core/frameworks";
import {
  getInstructionsStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { MIN_VERSION_PREFIX_LENGTH } from "@vm0/core/version-id";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, like } from "drizzle-orm";

import { env } from "../../lib/env";
import { generatePresignedGetUrl, putS3Object } from "../external/s3";
import type { Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { settle } from "../utils";
import {
  measureApiDispatchTiming,
  type ApiDispatchTimingCollector,
  type ApiDispatchTimingActionType,
} from "./api-dispatch-timing.service";
import { computeContentHashFromHashes } from "./storage-content-hash.service";

type StorageType = "artifact" | "volume";
type ManifestStorage = StorageManifest["storages"][number];
type ManifestArtifact = StorageManifest["artifacts"][number];
type OptionalManifestStorage = ManifestStorage | null;
type ComputedGetter = <T>(computedValue: Computed<T>) => T;

interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ManifestArtifact["missingRootPolicy"];
}

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
}

interface VolumeConfig {
  readonly name: string;
  readonly version: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface AgentConfig {
  readonly framework?: string;
  readonly volumes?: readonly string[];
  readonly instructions?: unknown;
}

interface AgentComposeContent {
  readonly agent?: AgentConfig;
  readonly agents?: Record<string, AgentConfig | undefined>;
  readonly volumes?: Record<string, VolumeConfig | undefined>;
}

interface PrepareAgentRunStorageManifestArgs {
  readonly db: Db;
  readonly content: AgentComposeContent;
  readonly vars: Record<string, string> | undefined;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly framework: SupportedFramework;
  readonly timing?: ApiDispatchTimingCollector;
}

interface ResolvedVolume {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly vasVersion: string;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface StorageResolution {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
}

interface StorageLookup {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: StorageType;
}

interface StorageIndexEntry {
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly headVersion: { readonly id: string; readonly s3Key: string } | null;
}

interface StorageManifestInputs {
  readonly artifacts: readonly ContextArtifact[];
  readonly composeVolumes: readonly ResolvedVolume[];
}

interface StorageManifestEntries {
  readonly composeEntries: readonly OptionalManifestStorage[];
  readonly additionalEntries: readonly OptionalManifestStorage[];
  readonly artifactEntries: ManifestArtifact[];
}

interface ResolvedManifestStorageInput {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly instructionsTargetFilename?: string;
  readonly resolved: StorageResolution;
}

interface ResolvedManifestArtifactInput {
  readonly artifact: ContextArtifact;
  readonly resolved: StorageResolution;
}

interface StorageManifestPhaseTimingWindow {
  startedAt: number | undefined;
  finishedAt: number | undefined;
}

/**
 * Pre-fetched (orgId, userId, name, type) -> storage row map. A single run
 * resolves dozens to hundreds of volumes/artifacts; looking each up with its
 * own `SELECT storages` round-trip saturates the connection pool, so all rows
 * for the relevant orgs are loaded once and resolved from memory instead.
 */
type StorageIndex = ReadonlyMap<string, StorageIndexEntry>;

const EMPTY_TAR_GZ = gzipSync(Buffer.alloc(1024, 0));
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

class StorageManifestEntryPhaseTiming {
  private readonly resolveWindow: StorageManifestPhaseTimingWindow = {
    startedAt: undefined,
    finishedAt: undefined,
  };
  private readonly generateWindow: StorageManifestPhaseTimingWindow = {
    startedAt: undefined,
    finishedAt: undefined,
  };

  constructor(
    private readonly timing: ApiDispatchTimingCollector | undefined,
    private readonly resolveActionType: ApiDispatchTimingActionType,
    private readonly generateActionType: ApiDispatchTimingActionType,
  ) {}

  async measureResolve<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.resolveWindow, operation);
  }

  async measureGenerate<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.generateWindow, operation);
  }

  flush(): void {
    this.record(this.resolveActionType, this.resolveWindow);
    this.record(this.generateActionType, this.generateWindow);
  }

  private async measure<T>(
    window: StorageManifestPhaseTimingWindow,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.timing) {
      return await operation();
    }

    const startedAt = now();
    window.startedAt =
      window.startedAt === undefined
        ? startedAt
        : Math.min(window.startedAt, startedAt);
    return await operation().finally(() => {
      const finishedAt = now();
      window.finishedAt =
        window.finishedAt === undefined
          ? finishedAt
          : Math.max(window.finishedAt, finishedAt);
    });
  }

  private record(
    actionType: ApiDispatchTimingActionType,
    window: StorageManifestPhaseTimingWindow,
  ): void {
    if (!this.timing) {
      return;
    }

    const finishedAt = window.finishedAt ?? now();
    this.timing.recordElapsed(
      actionType,
      "nested",
      window.startedAt ?? finishedAt,
      finishedAt,
    );
  }
}

async function withStorageManifestEntryPhaseTiming<T>(args: {
  readonly timing?: ApiDispatchTimingCollector;
  readonly resolveActionType: ApiDispatchTimingActionType;
  readonly generateActionType: ApiDispatchTimingActionType;
  readonly operation: (
    phaseTiming: StorageManifestEntryPhaseTiming,
  ) => Promise<T>;
}): Promise<T> {
  const phaseTiming = new StorageManifestEntryPhaseTiming(
    args.timing,
    args.resolveActionType,
    args.generateActionType,
  );
  return await args.operation(phaseTiming).finally(() => {
    phaseTiming.flush();
  });
}

function instructionsMountPath(framework: SupportedFramework): string {
  return framework === "codex" ? "/home/user/.codex" : "/home/user/.claude";
}

function firstAgentEntry(
  content: AgentComposeContent,
): { readonly name: string | undefined; readonly agent: AgentConfig } | null {
  if (content.agent) {
    return { name: undefined, agent: content.agent };
  }

  const firstEntry = Object.entries(content.agents ?? {})[0];
  if (!firstEntry?.[1]) {
    return null;
  }
  return { name: firstEntry[0], agent: firstEntry[1] };
}

function parseVolumeDeclaration(declaration: string): {
  readonly name: string;
  readonly mountPath: string;
} {
  const [name, mountPath, extra] = declaration.split(":");
  if (extra !== undefined || !name?.trim() || !mountPath?.trim()) {
    throw new Error(
      `Invalid volume declaration: ${declaration}. Expected format: volume-name:/mount/path`,
    );
  }
  return { name: name.trim(), mountPath: mountPath.trim() };
}

function expandTemplate(
  value: string,
  vars: Record<string, string> | undefined,
  context: string,
): string {
  const { result, missingVars } = expandVariablesInString(value, {
    vars: vars ?? {},
  });
  if (missingVars.length > 0) {
    throw new Error(
      `${context} is missing required variables: ${missingVars
        .map((ref) => {
          return ref.name;
        })
        .join(", ")}`,
    );
  }
  return result;
}

function resolveComposeVolumes(args: {
  readonly content: AgentComposeContent;
  readonly vars: Record<string, string> | undefined;
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly framework: SupportedFramework;
}): readonly ResolvedVolume[] {
  const entry = firstAgentEntry(args.content);
  if (!entry) {
    return [];
  }

  const resolved: ResolvedVolume[] = [];
  for (const declaration of entry.agent.volumes ?? []) {
    const parsed = parseVolumeDeclaration(declaration);
    const config = args.content.volumes?.[parsed.name];
    if (!config) {
      throw new Error(
        `Volume "${parsed.name}" is not defined in the volumes section`,
      );
    }

    const versionOverride = args.volumeVersionOverrides?.[parsed.name];
    resolved.push({
      name: parsed.name,
      mountPath: parsed.mountPath,
      vasStorageName: expandTemplate(
        config.name,
        args.vars,
        `Volume "${parsed.name}" name`,
      ),
      vasVersion: expandTemplate(
        versionOverride ?? config.version,
        args.vars,
        `Volume "${parsed.name}" version`,
      ),
      optional: config.optional,
      system: config.system,
    });
  }

  if (entry.agent.instructions && entry.name) {
    const storageName = getInstructionsStorageName(entry.name);
    resolved.push({
      name: storageName,
      mountPath: instructionsMountPath(args.framework),
      vasStorageName: storageName,
      vasVersion: "latest",
      instructionsTargetFilename: getInstructionsFilename(args.framework),
    });
  }

  return resolved;
}

function dedupArtifacts(
  artifacts: readonly ContextArtifact[],
): readonly ContextArtifact[] {
  const byName = new Map<string, ContextArtifact>();
  for (const artifact of artifacts) {
    byName.set(artifact.name, artifact);
  }
  return [...byName.values()];
}

function createEmptyStorageManifest(): string {
  return JSON.stringify({
    version: "1",
    createdAt: nowDate().toISOString(),
    totalSize: 0,
    fileCount: 0,
    files: [],
  });
}

async function findStorage(
  db: Db,
  lookup: StorageLookup,
): Promise<
  | {
      readonly id: string;
      readonly headVersionId: string | null;
      readonly s3Prefix: string;
    }
  | undefined
> {
  const [storage] = await db
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, lookup.orgId),
        eq(storages.userId, lookup.userId),
        eq(storages.name, lookup.name),
        eq(storages.type, lookup.type),
      ),
    )
    .limit(1);
  return storage;
}

function storageIndexKey(
  orgId: string,
  userId: string,
  name: string,
  type: string,
): string {
  return JSON.stringify([orgId, userId, name, type]);
}

async function loadStorageIndex(
  db: Db,
  orgIds: readonly string[],
): Promise<StorageIndex> {
  const uniqueOrgIds = [...new Set(orgIds)];
  const rows = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      type: storages.type,
      storageId: storages.id,
      headVersionId: storages.headVersionId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
    })
    .from(storages)
    .leftJoin(storageVersions, eq(storages.headVersionId, storageVersions.id))
    .where(inArray(storages.orgId, uniqueOrgIds));

  const index = new Map<string, StorageIndexEntry>();
  for (const row of rows) {
    index.set(storageIndexKey(row.orgId, row.userId, row.name, row.type), {
      storageId: row.storageId,
      headVersionId: row.headVersionId,
      headVersion:
        row.versionId && row.s3Key
          ? { id: row.versionId, s3Key: row.s3Key }
          : null,
    });
  }
  return index;
}

function ensureArtifactStorage(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly bucket: string;
}): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const lookup = {
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      type: "artifact" as const,
    };
    let storage = await findStorage(args.db, lookup);

    if (!storage) {
      const [created] = await args.db
        .insert(storages)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          name: args.name,
          type: "artifact",
          s3Prefix: `${args.orgId}/artifact/${args.name}`,
        })
        .onConflictDoNothing()
        .returning({
          id: storages.id,
          headVersionId: storages.headVersionId,
          s3Prefix: storages.s3Prefix,
        });
      storage = created ?? (await findStorage(args.db, lookup));
    }

    if (!storage) {
      throw new Error(`Failed to create artifact storage "${args.name}"`);
    }
    if (storage.headVersionId) {
      return;
    }

    const versionId = computeContentHashFromHashes(storage.id, []);
    const s3Key = `${storage.s3Prefix}/${versionId}`;
    await Promise.all([
      get(
        putS3Object(
          args.bucket,
          `${s3Key}/manifest.json`,
          createEmptyStorageManifest(),
          "application/json",
        ),
      ),
      get(
        putS3Object(
          args.bucket,
          `${s3Key}/archive.tar.gz`,
          EMPTY_TAR_GZ,
          "application/gzip",
        ),
      ),
    ]);

    await args.db.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: storage.id,
          s3Key,
          size: 0,
          fileCount: 0,
          message: "Initial empty artifact",
          createdBy: args.userId,
        })
        .onConflictDoNothing();
      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: 0,
          fileCount: 0,
          updatedAt: nowDate(),
        })
        .where(eq(storages.id, storage.id));
    });
  });
}

export function ensureUserArtifactStorage(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly bucket: string;
}): Computed<Promise<void>> {
  return ensureArtifactStorage(args);
}

function resolveLatestVersion(
  index: StorageIndex,
  lookup: StorageLookup,
): StorageResolution {
  const entry = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name, lookup.type),
  );

  if (!entry) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }
  if (!entry.headVersionId) {
    throw new Error(`Storage "${lookup.name}" has no HEAD version`);
  }
  if (!entry.headVersion) {
    throw new Error(`Storage "${lookup.name}" HEAD version not found`);
  }

  return {
    storageId: entry.storageId,
    versionId: entry.headVersion.id,
    s3Key: entry.headVersion.s3Key,
  };
}

async function resolvePinnedVersion(
  db: Db,
  index: StorageIndex,
  lookup: StorageLookup,
  version: string,
): Promise<StorageResolution> {
  const storage = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name, lookup.type),
  );
  if (!storage) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }

  const [exactMatch] = await db
    .select({ id: storageVersions.id, s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.storageId),
        eq(storageVersions.id, version),
      ),
    )
    .limit(1);
  if (exactMatch) {
    return {
      storageId: storage.storageId,
      versionId: exactMatch.id,
      s3Key: exactMatch.s3Key,
    };
  }

  if (
    version.length < MIN_VERSION_PREFIX_LENGTH ||
    !/^[a-f0-9]+$/i.test(version)
  ) {
    throw new Error(
      `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
    );
  }

  const matches = await db
    .select({ id: storageVersions.id, s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.storageId),
        like(storageVersions.id, `${version}%`),
      ),
    )
    .limit(2);
  if (matches.length === 0) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous version prefix "${version}" for storage "${lookup.name}". Please use more characters.`,
    );
  }

  const match = matches[0];
  if (!match) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  return {
    storageId: storage.storageId,
    versionId: match.id,
    s3Key: match.s3Key,
  };
}

async function resolveStorageVersion(
  db: Db,
  index: StorageIndex,
  lookup: StorageLookup,
  version: string | undefined,
): Promise<StorageResolution> {
  return version === undefined || version === "latest"
    ? resolveLatestVersion(index, lookup)
    : await resolvePinnedVersion(db, index, lookup, version);
}

function isMissingStorageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("not found in database") ||
      error.message.includes("has no HEAD version"))
  );
}

function volumeStorageName(volume: ResolvedVolume | AdditionalVolume): string {
  return "vasStorageName" in volume ? volume.vasStorageName : volume.name;
}

function volumeVersion(
  volume: ResolvedVolume | AdditionalVolume,
): string | undefined {
  return "vasVersion" in volume ? volume.vasVersion : volume.version;
}

async function resolveVolumeStorage(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly volume: ResolvedVolume | AdditionalVolume;
  readonly primaryOrgId: string;
  readonly allowSystemFallback: boolean;
}): Promise<StorageResolution | null> {
  if (args.allowSystemFallback && args.volume.system) {
    const systemResult = await settle(
      resolveStorageVersion(
        args.db,
        args.index,
        {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: volumeStorageName(args.volume),
          type: "volume",
        },
        volumeVersion(args.volume),
      ),
    );
    if (systemResult.ok) {
      return systemResult.value;
    }
    if (!isMissingStorageError(systemResult.error)) {
      throw systemResult.error;
    }
  }

  return await resolveStorageVersion(
    args.db,
    args.index,
    {
      orgId: args.primaryOrgId,
      userId: VOLUME_ORG_USER_ID,
      name: volumeStorageName(args.volume),
      type: "volume",
    },
    volumeVersion(args.volume),
  );
}

function buildStorageEntry(args: {
  readonly bucket: string;
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly instructionsTargetFilename?: string;
  readonly resolved: StorageResolution;
}): Computed<Promise<ManifestStorage>> {
  return computed(async (get): Promise<ManifestStorage> => {
    const archiveUrl = await get(
      generatePresignedGetUrl(
        args.bucket,
        `${args.resolved.s3Key}/archive.tar.gz`,
        DOWNLOAD_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    );
    return {
      name: args.name,
      mountPath: args.mountPath,
      vasStorageName: args.vasStorageName,
      vasVersionId: args.resolved.versionId,
      ...(args.instructionsTargetFilename
        ? { instructionsTargetFilename: args.instructionsTargetFilename }
        : {}),
      archiveUrl,
    };
  });
}

async function resolveComposeStorageInput(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
}): Promise<ResolvedManifestStorageInput | null> {
  const resolvedResult = await settle(
    resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.agentOrgId,
      allowSystemFallback: true,
    }),
  );
  if (!resolvedResult.ok) {
    if (args.volume.optional && isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.value) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.vasStorageName,
    instructionsTargetFilename: args.volume.instructionsTargetFilename,
    resolved: resolvedResult.value,
  };
}

async function resolveAdditionalStorageInput(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
}): Promise<ResolvedManifestStorageInput | null> {
  const resolvedResult = await settle(
    resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.runtimeOrgId,
      allowSystemFallback: true,
    }),
  );
  if (!resolvedResult.ok) {
    if (isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.value) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved: resolvedResult.value,
  };
}

async function resolveArtifactStorageInput(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifact: ContextArtifact;
}): Promise<ResolvedManifestArtifactInput> {
  const resolved = await resolveStorageVersion(
    args.db,
    args.index,
    {
      orgId: args.runtimeOrgId,
      userId: args.userId,
      name: args.artifact.name,
      type: "artifact",
    },
    args.artifact.version,
  );
  return { artifact: args.artifact, resolved };
}

async function buildStorageEntryFromInput(
  get: ComputedGetter,
  args: {
    readonly bucket: string;
    readonly input: ResolvedManifestStorageInput | null;
  },
): Promise<ManifestStorage | null> {
  if (!args.input) {
    return null;
  }
  return await get(
    buildStorageEntry({
      bucket: args.bucket,
      ...args.input,
    }),
  );
}

async function buildArtifactEntryFromInput(
  get: ComputedGetter,
  args: {
    readonly bucket: string;
    readonly input: ResolvedManifestArtifactInput;
  },
): Promise<ManifestArtifact> {
  const { artifact, resolved } = args.input;
  const archiveUrl = await get(
    generatePresignedGetUrl(
      args.bucket,
      `${resolved.s3Key}/archive.tar.gz`,
      DOWNLOAD_URL_TTL_SECONDS,
      undefined,
      true,
    ),
  );

  return {
    mountPath: artifact.mountPath,
    vasStorageName: artifact.name,
    vasStorageId: resolved.storageId,
    vasVersionId: resolved.versionId,
    archiveUrl,
    ...(artifact.missingRootPolicy
      ? { missingRootPolicy: artifact.missingRootPolicy }
      : {}),
  };
}

async function buildComposeStorageEntry(
  get: ComputedGetter,
  args: {
    readonly db: Db;
    readonly index: StorageIndex;
    readonly bucket: string;
    readonly agentOrgId: string;
    readonly volume: ResolvedVolume;
    readonly phaseTiming: StorageManifestEntryPhaseTiming;
  },
): Promise<ManifestStorage | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveComposeStorageInput({
      db: args.db,
      index: args.index,
      agentOrgId: args.agentOrgId,
      volume: args.volume,
    });
  });
  return await args.phaseTiming.measureGenerate(() => {
    return buildStorageEntryFromInput(get, {
      bucket: args.bucket,
      input,
    });
  });
}

async function buildAdditionalStorageEntry(
  get: ComputedGetter,
  args: {
    readonly db: Db;
    readonly index: StorageIndex;
    readonly bucket: string;
    readonly runtimeOrgId: string;
    readonly volume: AdditionalVolume;
    readonly phaseTiming: StorageManifestEntryPhaseTiming;
  },
): Promise<ManifestStorage | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveAdditionalStorageInput({
      db: args.db,
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      volume: args.volume,
    });
  });
  return await args.phaseTiming.measureGenerate(() => {
    return buildStorageEntryFromInput(get, {
      bucket: args.bucket,
      input,
    });
  });
}

async function buildArtifactEntry(
  get: ComputedGetter,
  args: {
    readonly db: Db;
    readonly index: StorageIndex;
    readonly bucket: string;
    readonly runtimeOrgId: string;
    readonly userId: string;
    readonly artifact: ContextArtifact;
    readonly phaseTiming: StorageManifestEntryPhaseTiming;
  },
): Promise<ManifestArtifact> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveArtifactStorageInput({
      db: args.db,
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      userId: args.userId,
      artifact: args.artifact,
    });
  });
  return await args.phaseTiming.measureGenerate(() => {
    return buildArtifactEntryFromInput(get, {
      bucket: args.bucket,
      input,
    });
  });
}

function mergeStorageEntries(args: {
  readonly composeEntries: readonly ManifestStorage[];
  readonly additionalEntries: readonly ManifestStorage[];
}): readonly ManifestStorage[] {
  const additionalMountPaths = new Set(
    args.additionalEntries.map((entry) => {
      return entry.mountPath;
    }),
  );
  return [
    ...args.composeEntries.filter((entry) => {
      return !additionalMountPaths.has(entry.mountPath);
    }),
    ...args.additionalEntries,
  ];
}

function isManifestStorage(
  entry: OptionalManifestStorage,
): entry is ManifestStorage {
  return entry !== null;
}

async function resolveStorageManifestInputs(
  args: PrepareAgentRunStorageManifestArgs,
): Promise<StorageManifestInputs> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_resolve_inputs",
    "nested",
    () => {
      return {
        artifacts: dedupArtifacts(args.artifacts),
        composeVolumes: resolveComposeVolumes({
          content: args.content,
          vars: args.vars,
          volumeVersionOverrides: args.volumeVersionOverrides,
          framework: args.framework,
        }),
      };
    },
  );
}

async function ensureStorageManifestArtifacts(
  get: ComputedGetter,
  args: {
    readonly db: Db;
    readonly runtimeOrgId: string;
    readonly userId: string;
    readonly bucket: string;
    readonly artifacts: readonly ContextArtifact[];
    readonly timing?: ApiDispatchTimingCollector;
  },
): Promise<void> {
  await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_ensure_artifacts",
    "nested",
    async () => {
      await Promise.all(
        args.artifacts.map((artifact) => {
          return get(
            ensureArtifactStorage({
              db: args.db,
              orgId: args.runtimeOrgId,
              userId: args.userId,
              name: artifact.name,
              bucket: args.bucket,
            }),
          );
        }),
      );
    },
  );
}

async function loadTimedStorageIndex(args: {
  readonly db: Db;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<StorageIndex> {
  // Resolve every volume/artifact from one pre-fetched snapshot instead of a
  // per-item `SELECT storages` round-trip. Loaded after ensureArtifactStorage
  // so freshly created artifact rows are included.
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_load_storage_index",
    "nested",
    async () => {
      return await loadStorageIndex(args.db, [
        args.agentOrgId,
        args.runtimeOrgId,
        SYSTEM_ORG_ID,
      ]);
    },
  );
}

async function buildStorageManifestEntries(
  get: ComputedGetter,
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly storageIndex: StorageIndex;
    readonly agentOrgId: string;
    readonly runtimeOrgId: string;
    readonly userId: string;
    readonly composeVolumes: readonly ResolvedVolume[];
    readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
    readonly artifacts: readonly ContextArtifact[];
    readonly timing?: ApiDispatchTimingCollector;
  },
): Promise<StorageManifestEntries> {
  const [composeEntries, additionalEntries, artifactEntries] =
    await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_build_entries",
      "nested",
      async () => {
        return await Promise.all([
          measureApiDispatchTiming(
            args.timing,
            "api_dispatch_prepare_storage_manifest_build_compose_entries",
            "nested",
            async () => {
              return await withStorageManifestEntryPhaseTiming({
                timing: args.timing,
                resolveActionType:
                  "api_dispatch_prepare_storage_manifest_resolve_compose_versions",
                generateActionType:
                  "api_dispatch_prepare_storage_manifest_generate_compose_urls",
                operation: async (phaseTiming) => {
                  return await Promise.all(
                    args.composeVolumes.map((volume) => {
                      return buildComposeStorageEntry(get, {
                        db: args.db,
                        index: args.storageIndex,
                        bucket: args.bucket,
                        agentOrgId: args.agentOrgId,
                        volume,
                        phaseTiming,
                      });
                    }),
                  );
                },
              });
            },
          ),
          measureApiDispatchTiming(
            args.timing,
            "api_dispatch_prepare_storage_manifest_build_additional_entries",
            "nested",
            async () => {
              return await withStorageManifestEntryPhaseTiming({
                timing: args.timing,
                resolveActionType:
                  "api_dispatch_prepare_storage_manifest_resolve_additional_versions",
                generateActionType:
                  "api_dispatch_prepare_storage_manifest_generate_additional_urls",
                operation: async (phaseTiming) => {
                  return await Promise.all(
                    (args.additionalVolumes ?? []).map((volume) => {
                      return buildAdditionalStorageEntry(get, {
                        db: args.db,
                        index: args.storageIndex,
                        bucket: args.bucket,
                        runtimeOrgId: args.runtimeOrgId,
                        volume,
                        phaseTiming,
                      });
                    }),
                  );
                },
              });
            },
          ),
          measureApiDispatchTiming(
            args.timing,
            "api_dispatch_prepare_storage_manifest_build_artifact_entries",
            "nested",
            async () => {
              return await withStorageManifestEntryPhaseTiming({
                timing: args.timing,
                resolveActionType:
                  "api_dispatch_prepare_storage_manifest_resolve_artifact_versions",
                generateActionType:
                  "api_dispatch_prepare_storage_manifest_generate_artifact_urls",
                operation: async (phaseTiming) => {
                  return await Promise.all(
                    args.artifacts.map((artifact) => {
                      return buildArtifactEntry(get, {
                        db: args.db,
                        index: args.storageIndex,
                        bucket: args.bucket,
                        runtimeOrgId: args.runtimeOrgId,
                        userId: args.userId,
                        artifact,
                        phaseTiming,
                      });
                    }),
                  );
                },
              });
            },
          ),
        ]);
      },
    );

  return { composeEntries, additionalEntries, artifactEntries };
}

async function assembleStorageManifest(args: {
  readonly composeEntries: readonly OptionalManifestStorage[];
  readonly additionalEntries: readonly OptionalManifestStorage[];
  readonly artifactEntries: ManifestArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<StorageManifest> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_assemble",
    "nested",
    () => {
      return {
        storages: [
          ...mergeStorageEntries({
            composeEntries: args.composeEntries.filter(isManifestStorage),
            additionalEntries: args.additionalEntries.filter(isManifestStorage),
          }),
        ],
        artifacts: args.artifactEntries,
      };
    },
  );
}

export function prepareAgentRunStorageManifest(
  args: PrepareAgentRunStorageManifestArgs,
): Computed<Promise<StorageManifest>> {
  return computed(async (get): Promise<StorageManifest> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const { artifacts, composeVolumes } =
      await resolveStorageManifestInputs(args);

    await ensureStorageManifestArtifacts(get, {
      db: args.db,
      runtimeOrgId: args.runtimeOrgId,
      userId: args.userId,
      bucket,
      artifacts,
      timing: args.timing,
    });

    const storageIndex = await loadTimedStorageIndex({
      db: args.db,
      agentOrgId: args.agentOrgId,
      runtimeOrgId: args.runtimeOrgId,
      timing: args.timing,
    });

    const entries = await buildStorageManifestEntries(get, {
      db: args.db,
      bucket,
      storageIndex,
      agentOrgId: args.agentOrgId,
      runtimeOrgId: args.runtimeOrgId,
      userId: args.userId,
      composeVolumes,
      additionalVolumes: args.additionalVolumes,
      artifacts,
      timing: args.timing,
    });

    return await assembleStorageManifest({
      ...entries,
      timing: args.timing,
    });
  });
}
