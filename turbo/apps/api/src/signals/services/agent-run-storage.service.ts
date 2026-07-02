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
  resolveSystemStoragePresignedUrls,
  SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  systemStoragePresignedUrlCacheKey,
  type SystemStoragePresignedUrlCacheStatus,
  type SystemStoragePresignedUrlRequest,
} from "./system-storage-presigned-url-cache.service";
import {
  measureApiDispatchTiming,
  type ApiDispatchTimingCollector,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingDimensionsInput,
} from "./api-dispatch-timing.service";
import { computeContentHashFromHashes } from "./storage-content-hash.service";

type StorageType = "artifact" | "volume";
type ManifestStorage = StorageManifest["storages"][number];
type ManifestArtifact = StorageManifest["artifacts"][number];
type ComputedGetter = <T>(computedValue: Computed<T>) => T;
type StorageManifestEntryKind = "compose" | "additional" | "artifact";
type StorageManifestCountBucket =
  (typeof STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS)[number];

interface PresignCandidateInput {
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number;
  readonly filename: string | undefined;
  readonly usePublicEndpoint: boolean;
}

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
  readonly stats?: StorageManifestBuildStats;
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
  readonly resolvedOrgId: string;
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
  readonly composeEntries: readonly ManifestStorage[];
  readonly additionalEntries: readonly ManifestStorage[];
  readonly artifactEntries: ManifestArtifact[];
  readonly resolvedComposeEntryCount: number;
  readonly resolvedAdditionalEntryCount: number;
}

interface BuildStorageManifestEntriesArgs {
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
  readonly stats?: StorageManifestBuildStats;
}

interface StorageManifestEntryPhaseTimings {
  readonly compose: StorageManifestEntryPhaseTiming;
  readonly additional: StorageManifestEntryPhaseTiming;
  readonly artifact: StorageManifestEntryPhaseTiming;
}

interface ResolvedStorageManifestEntryPlans {
  readonly composePlans: readonly ResolvedManifestStoragePlan[];
  readonly additionalPlans: readonly ResolvedManifestStoragePlan[];
  readonly artifactInputs: readonly ResolvedManifestArtifactInput[];
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

interface ResolvedManifestStoragePlan extends ResolvedManifestStorageInput {
  readonly entryKind: Extract<
    StorageManifestEntryKind,
    "compose" | "additional"
  >;
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
const STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

function storageManifestCountBucket(count: number): StorageManifestCountBucket {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

export class StorageManifestBuildStats {
  private requestedComposeCount = 0;
  private requestedAdditionalCount = 0;
  private requestedArtifactCount = 0;
  private dedupedArtifactCount = 0;
  private resolvedComposeCount = 0;
  private resolvedAdditionalCount = 0;
  private resolvedArtifactCount = 0;
  private finalStorageCount = 0;
  private finalArtifactCount = 0;
  private droppedComposeCount = 0;
  private plannedComposePresignCount = 0;
  private plannedAdditionalPresignCount = 0;
  private plannedArtifactPresignCount = 0;
  private systemResolvedStorageCount = 0;
  private systemPresignCacheHitCount = 0;
  private systemPresignCacheMissCount = 0;
  private systemPresignCacheStaleReuseCount = 0;
  private systemPresignCacheSyncRefreshCount = 0;
  private nonSystemPresignCount = 0;
  private readonly presignCandidateCounts = new Map<string, number>();

  recordRequestedInputs(args: {
    readonly composeCount: number;
    readonly additionalCount: number;
    readonly artifactCount: number;
    readonly dedupedArtifactCount: number;
  }): void {
    this.requestedComposeCount = args.composeCount;
    this.requestedAdditionalCount = args.additionalCount;
    this.requestedArtifactCount = args.artifactCount;
    this.dedupedArtifactCount = args.dedupedArtifactCount;
  }

  recordResolvedEntry(kind: StorageManifestEntryKind, count = 1): void {
    switch (kind) {
      case "compose": {
        this.resolvedComposeCount += count;
        return;
      }
      case "additional": {
        this.resolvedAdditionalCount += count;
        return;
      }
      case "artifact": {
        this.resolvedArtifactCount += count;
        return;
      }
    }
  }

  recordPresignCandidate(
    kind: StorageManifestEntryKind,
    input: PresignCandidateInput,
  ): void {
    switch (kind) {
      case "compose": {
        this.plannedComposePresignCount += 1;
        break;
      }
      case "additional": {
        this.plannedAdditionalPresignCount += 1;
        break;
      }
      case "artifact": {
        this.plannedArtifactPresignCount += 1;
        break;
      }
    }

    const key = JSON.stringify([
      input.bucket,
      input.key,
      input.expiresIn,
      input.filename ?? "",
      input.usePublicEndpoint ? "public" : "private",
    ]);
    this.presignCandidateCounts.set(
      key,
      (this.presignCandidateCounts.get(key) ?? 0) + 1,
    );
  }

  recordSystemResolvedStorage(count = 1): void {
    this.systemResolvedStorageCount += count;
  }

  recordSystemPresignCacheResult(
    status: SystemStoragePresignedUrlCacheStatus,
  ): void {
    switch (status) {
      case "hit": {
        this.systemPresignCacheHitCount += 1;
        return;
      }
      case "miss": {
        this.systemPresignCacheMissCount += 1;
        return;
      }
      case "stale_reuse": {
        this.systemPresignCacheStaleReuseCount += 1;
        return;
      }
      case "sync_refresh": {
        this.systemPresignCacheSyncRefreshCount += 1;
        return;
      }
    }
  }

  recordNonSystemPresign(): void {
    this.nonSystemPresignCount += 1;
  }

  recordFinalManifest(args: {
    readonly composeEntries: readonly ManifestStorage[];
    readonly additionalEntries: readonly ManifestStorage[];
    readonly finalStorageEntries: readonly ManifestStorage[];
    readonly finalArtifactEntries: readonly ManifestArtifact[];
    readonly resolvedComposeEntryCount?: number;
    readonly resolvedAdditionalEntryCount?: number;
  }): void {
    this.finalStorageCount = args.finalStorageEntries.length;
    this.finalArtifactCount = args.finalArtifactEntries.length;
    this.droppedComposeCount =
      (args.resolvedComposeEntryCount ?? args.composeEntries.length) +
      (args.resolvedAdditionalEntryCount ?? args.additionalEntries.length) -
      args.finalStorageEntries.length;
  }

  overallDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_requested_compose_count_bucket:
        storageManifestCountBucket(this.requestedComposeCount),
      storage_manifest_requested_additional_count_bucket:
        storageManifestCountBucket(this.requestedAdditionalCount),
      storage_manifest_requested_artifact_count_bucket:
        storageManifestCountBucket(this.requestedArtifactCount),
      storage_manifest_deduped_artifact_count_bucket:
        storageManifestCountBucket(this.dedupedArtifactCount),
      storage_manifest_resolved_compose_count_bucket:
        storageManifestCountBucket(this.resolvedComposeCount),
      storage_manifest_resolved_additional_count_bucket:
        storageManifestCountBucket(this.resolvedAdditionalCount),
      storage_manifest_resolved_artifact_count_bucket:
        storageManifestCountBucket(this.resolvedArtifactCount),
      storage_manifest_final_storage_count_bucket: storageManifestCountBucket(
        this.finalStorageCount,
      ),
      storage_manifest_final_artifact_count_bucket: storageManifestCountBucket(
        this.finalArtifactCount,
      ),
      storage_manifest_dropped_compose_count_bucket: storageManifestCountBucket(
        this.droppedComposeCount,
      ),
      storage_manifest_planned_presign_count_bucket: storageManifestCountBucket(
        this.plannedPresignCount(),
      ),
      storage_manifest_duplicate_presign_candidate_count_bucket:
        storageManifestCountBucket(this.duplicatePresignCandidateCount()),
      ...this.systemPresignCacheDimensions(),
    };
  }

  buildEntriesDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_resolved_compose_count_bucket:
        storageManifestCountBucket(this.resolvedComposeCount),
      storage_manifest_resolved_additional_count_bucket:
        storageManifestCountBucket(this.resolvedAdditionalCount),
      storage_manifest_resolved_artifact_count_bucket:
        storageManifestCountBucket(this.resolvedArtifactCount),
      storage_manifest_planned_presign_count_bucket: storageManifestCountBucket(
        this.plannedPresignCount(),
      ),
      storage_manifest_duplicate_presign_candidate_count_bucket:
        storageManifestCountBucket(this.duplicatePresignCandidateCount()),
      ...this.systemPresignCacheDimensions(),
    };
  }

  generateDimensions(
    kind: StorageManifestEntryKind,
  ): ApiDispatchTimingDimensions {
    switch (kind) {
      case "compose": {
        return {
          storage_manifest_compose_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedComposePresignCount),
        };
      }
      case "additional": {
        return {
          storage_manifest_additional_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedAdditionalPresignCount),
        };
      }
      case "artifact": {
        return {
          storage_manifest_artifact_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedArtifactPresignCount),
        };
      }
    }
  }

  assembleDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_final_storage_count_bucket: storageManifestCountBucket(
        this.finalStorageCount,
      ),
      storage_manifest_final_artifact_count_bucket: storageManifestCountBucket(
        this.finalArtifactCount,
      ),
      storage_manifest_dropped_compose_count_bucket: storageManifestCountBucket(
        this.droppedComposeCount,
      ),
    };
  }

  private plannedPresignCount(): number {
    return (
      this.plannedComposePresignCount +
      this.plannedAdditionalPresignCount +
      this.plannedArtifactPresignCount
    );
  }

  private duplicatePresignCandidateCount(): number {
    let count = 0;
    for (const candidateCount of this.presignCandidateCounts.values()) {
      count += Math.max(0, candidateCount - 1);
    }
    return count;
  }

  private systemPresignCacheDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_system_resolved_storage_count_bucket:
        storageManifestCountBucket(this.systemResolvedStorageCount),
      storage_manifest_system_presign_cache_hit_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheHitCount),
      storage_manifest_system_presign_cache_miss_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheMissCount),
      storage_manifest_system_presign_cache_stale_reuse_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheStaleReuseCount),
      storage_manifest_system_presign_cache_sync_refresh_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheSyncRefreshCount),
      storage_manifest_non_system_presign_count_bucket:
        storageManifestCountBucket(this.nonSystemPresignCount),
    };
  }
}

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
    private readonly resolveDimensions:
      | ApiDispatchTimingDimensionsInput
      | undefined,
    private readonly generateDimensions:
      | ApiDispatchTimingDimensionsInput
      | undefined,
  ) {}

  async measureResolve<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.resolveWindow, operation);
  }

  async measureGenerate<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.generateWindow, operation);
  }

  flush(): void {
    this.record(
      this.resolveActionType,
      this.resolveWindow,
      this.resolveDimensions,
    );
    this.record(
      this.generateActionType,
      this.generateWindow,
      this.generateDimensions,
    );
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
    dimensions: ApiDispatchTimingDimensionsInput | undefined,
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
      dimensions,
    );
  }
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
    resolvedOrgId: lookup.orgId,
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
      resolvedOrgId: lookup.orgId,
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
    resolvedOrgId: lookup.orgId,
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

function storageArchiveKey(resolved: StorageResolution): string {
  return `${resolved.s3Key}/archive.tar.gz`;
}

function isSystemOwnedStoragePlan(plan: ResolvedManifestStoragePlan): boolean {
  return plan.resolved.resolvedOrgId === SYSTEM_ORG_ID;
}

function systemStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
}): SystemStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.plan.resolved),
    storageVersionId: args.plan.resolved.versionId,
    publicEndpoint: true,
  };
}

async function generateDirectStorageArchiveUrl(
  get: ComputedGetter,
  args: {
    readonly bucket: string;
    readonly archiveKey: string;
    readonly stats?: StorageManifestBuildStats;
    readonly entryKind: StorageManifestEntryKind;
  },
): Promise<string> {
  args.stats?.recordPresignCandidate(args.entryKind, {
    bucket: args.bucket,
    key: args.archiveKey,
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    filename: undefined,
    usePublicEndpoint: true,
  });
  args.stats?.recordNonSystemPresign();
  return await get(
    generatePresignedGetUrl(
      args.bucket,
      args.archiveKey,
      DOWNLOAD_URL_TTL_SECONDS,
      undefined,
      true,
    ),
  );
}

function buildStorageManifestEntry(args: {
  readonly plan: ResolvedManifestStoragePlan;
  readonly archiveUrl: string;
}): ManifestStorage {
  return {
    name: args.plan.name,
    mountPath: args.plan.mountPath,
    vasStorageName: args.plan.vasStorageName,
    vasVersionId: args.plan.resolved.versionId,
    ...(args.plan.instructionsTargetFilename
      ? { instructionsTargetFilename: args.plan.instructionsTargetFilename }
      : {}),
    archiveUrl: args.archiveUrl,
  };
}

async function buildStorageEntriesFromPlans(
  get: ComputedGetter,
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly plans: readonly ResolvedManifestStoragePlan[];
    readonly stats?: StorageManifestBuildStats;
  },
): Promise<readonly ManifestStorage[]> {
  const systemPlans = args.plans.filter(isSystemOwnedStoragePlan);
  args.stats?.recordSystemResolvedStorage(systemPlans.length);

  const systemRequests = systemPlans.map((plan) => {
    return systemStoragePresignedUrlRequest({ bucket: args.bucket, plan });
  });
  const systemUrlsByCacheKey = await resolveSystemStoragePresignedUrls({
    db: args.db,
    get,
    requests: systemRequests,
  });

  return await Promise.all(
    args.plans.map(async (plan) => {
      const archiveKey = storageArchiveKey(plan.resolved);
      if (!isSystemOwnedStoragePlan(plan)) {
        return buildStorageManifestEntry({
          plan,
          archiveUrl: await generateDirectStorageArchiveUrl(get, {
            bucket: args.bucket,
            archiveKey,
            stats: args.stats,
            entryKind: plan.entryKind,
          }),
        });
      }

      const request = systemStoragePresignedUrlRequest({
        bucket: args.bucket,
        plan,
      });
      const cacheKey = systemStoragePresignedUrlCacheKey(request);
      const result = systemUrlsByCacheKey.get(cacheKey);
      if (!result) {
        throw new Error("Missing system storage presigned URL cache result");
      }
      args.stats?.recordSystemPresignCacheResult(result.status);
      if (result.status === "miss" || result.status === "sync_refresh") {
        args.stats?.recordPresignCandidate(plan.entryKind, {
          bucket: args.bucket,
          key: archiveKey,
          expiresIn: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
          filename: undefined,
          usePublicEndpoint: true,
        });
      }
      return buildStorageManifestEntry({ plan, archiveUrl: result.url });
    }),
  );
}

async function buildArtifactEntryFromInput(
  get: ComputedGetter,
  args: {
    readonly bucket: string;
    readonly input: ResolvedManifestArtifactInput;
    readonly stats?: StorageManifestBuildStats;
  },
): Promise<ManifestArtifact> {
  const { artifact, resolved } = args.input;
  const archiveKey = `${resolved.s3Key}/archive.tar.gz`;
  args.stats?.recordPresignCandidate("artifact", {
    bucket: args.bucket,
    key: archiveKey,
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    filename: undefined,
    usePublicEndpoint: true,
  });
  args.stats?.recordNonSystemPresign();
  const archiveUrl = await get(
    generatePresignedGetUrl(
      args.bucket,
      archiveKey,
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

async function buildComposeStorageEntry(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
  readonly phaseTiming: StorageManifestEntryPhaseTiming;
  readonly stats?: StorageManifestBuildStats;
}): Promise<ResolvedManifestStoragePlan | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveComposeStorageInput({
      db: args.db,
      index: args.index,
      agentOrgId: args.agentOrgId,
      volume: args.volume,
    });
  });
  if (input) {
    args.stats?.recordResolvedEntry("compose");
  }
  return input ? { ...input, entryKind: "compose" } : null;
}

async function buildAdditionalStorageEntry(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly phaseTiming: StorageManifestEntryPhaseTiming;
  readonly stats?: StorageManifestBuildStats;
}): Promise<ResolvedManifestStoragePlan | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveAdditionalStorageInput({
      db: args.db,
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      volume: args.volume,
    });
  });
  if (input) {
    args.stats?.recordResolvedEntry("additional");
  }
  return input ? { ...input, entryKind: "additional" } : null;
}

function mergeStorageEntries<
  TEntry extends { readonly mountPath: string },
>(args: {
  readonly composeEntries: readonly TEntry[];
  readonly additionalEntries: readonly TEntry[];
}): readonly TEntry[] {
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

function createStorageManifestEntryPhaseTimings(args: {
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): StorageManifestEntryPhaseTimings {
  return {
    compose: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_compose_versions",
      "api_dispatch_prepare_storage_manifest_generate_compose_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("compose");
      },
    ),
    additional: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_additional_versions",
      "api_dispatch_prepare_storage_manifest_generate_additional_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("additional");
      },
    ),
    artifact: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_artifact_versions",
      "api_dispatch_prepare_storage_manifest_generate_artifact_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("artifact");
      },
    ),
  };
}

function isResolvedManifestStoragePlan(
  plan: ResolvedManifestStoragePlan | null,
): plan is ResolvedManifestStoragePlan {
  return plan !== null;
}

async function resolveStorageManifestEntryPlans(args: {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
}): Promise<ResolvedStorageManifestEntryPlans> {
  const input = args.input;
  const [composePlans, additionalPlans, artifactInputs] = await Promise.all([
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_compose_entries",
      "nested",
      async () => {
        return await Promise.all(
          input.composeVolumes.map((volume) => {
            return buildComposeStorageEntry({
              db: input.db,
              index: input.storageIndex,
              agentOrgId: input.agentOrgId,
              volume,
              phaseTiming: args.phaseTimings.compose,
              stats: input.stats,
            });
          }),
        );
      },
    ),
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_additional_entries",
      "nested",
      async () => {
        return await Promise.all(
          (input.additionalVolumes ?? []).map((volume) => {
            return buildAdditionalStorageEntry({
              db: input.db,
              index: input.storageIndex,
              runtimeOrgId: input.runtimeOrgId,
              volume,
              phaseTiming: args.phaseTimings.additional,
              stats: input.stats,
            });
          }),
        );
      },
    ),
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_artifact_entries",
      "nested",
      async () => {
        return await Promise.all(
          input.artifacts.map((artifact) => {
            return args.phaseTimings.artifact.measureResolve(() => {
              return resolveArtifactStorageInput({
                db: input.db,
                index: input.storageIndex,
                runtimeOrgId: input.runtimeOrgId,
                userId: input.userId,
                artifact,
              });
            });
          }),
        );
      },
    ),
  ]);

  input.stats?.recordResolvedEntry("artifact", artifactInputs.length);

  return {
    composePlans: composePlans.filter(isResolvedManifestStoragePlan),
    additionalPlans: additionalPlans.filter(isResolvedManifestStoragePlan),
    artifactInputs,
  };
}

async function generateStorageManifestEntriesFromPlans(args: {
  readonly get: ComputedGetter;
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
  readonly resolved: ResolvedStorageManifestEntryPlans;
}): Promise<StorageManifestEntries> {
  const finalStoragePlans = mergeStorageEntries({
    composeEntries: args.resolved.composePlans,
    additionalEntries: args.resolved.additionalPlans,
  });
  const finalComposePlans = finalStoragePlans.filter((plan) => {
    return plan.entryKind === "compose";
  });
  const finalAdditionalPlans = finalStoragePlans.filter((plan) => {
    return plan.entryKind === "additional";
  });

  const [composeEntries, additionalEntries, artifactEntries] =
    await Promise.all([
      args.phaseTimings.compose.measureGenerate(() => {
        return buildStorageEntriesFromPlans(args.get, {
          db: args.input.db,
          bucket: args.input.bucket,
          plans: finalComposePlans,
          stats: args.input.stats,
        });
      }),
      args.phaseTimings.additional.measureGenerate(() => {
        return buildStorageEntriesFromPlans(args.get, {
          db: args.input.db,
          bucket: args.input.bucket,
          plans: finalAdditionalPlans,
          stats: args.input.stats,
        });
      }),
      args.phaseTimings.artifact.measureGenerate(() => {
        return Promise.all(
          args.resolved.artifactInputs.map((input) => {
            return buildArtifactEntryFromInput(args.get, {
              bucket: args.input.bucket,
              input,
              stats: args.input.stats,
            });
          }),
        );
      }),
    ]);

  return {
    composeEntries,
    additionalEntries,
    artifactEntries,
    resolvedComposeEntryCount: args.resolved.composePlans.length,
    resolvedAdditionalEntryCount: args.resolved.additionalPlans.length,
  };
}

async function buildStorageManifestEntries(
  get: ComputedGetter,
  args: BuildStorageManifestEntriesArgs,
): Promise<StorageManifestEntries> {
  const phaseTimings = createStorageManifestEntryPhaseTimings({
    timing: args.timing,
    stats: args.stats,
  });

  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_build_entries",
    "nested",
    async () => {
      return await (async () => {
        const resolved = await resolveStorageManifestEntryPlans({
          input: args,
          phaseTimings,
        });
        return await generateStorageManifestEntriesFromPlans({
          get,
          input: args,
          phaseTimings,
          resolved,
        });
      })().finally(() => {
        phaseTimings.compose.flush();
        phaseTimings.additional.flush();
        phaseTimings.artifact.flush();
      });
    },
    () => {
      return args.stats?.buildEntriesDimensions();
    },
  );
}

async function assembleStorageManifest(args: {
  readonly composeEntries: readonly ManifestStorage[];
  readonly additionalEntries: readonly ManifestStorage[];
  readonly artifactEntries: ManifestArtifact[];
  readonly resolvedComposeEntryCount: number;
  readonly resolvedAdditionalEntryCount: number;
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): Promise<StorageManifest> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_assemble",
    "nested",
    () => {
      const storages = mergeStorageEntries({
        composeEntries: args.composeEntries,
        additionalEntries: args.additionalEntries,
      });
      args.stats?.recordFinalManifest({
        composeEntries: args.composeEntries,
        additionalEntries: args.additionalEntries,
        finalStorageEntries: storages,
        finalArtifactEntries: args.artifactEntries,
        resolvedComposeEntryCount: args.resolvedComposeEntryCount,
        resolvedAdditionalEntryCount: args.resolvedAdditionalEntryCount,
      });
      return {
        storages: [...storages],
        artifacts: args.artifactEntries,
      };
    },
    () => {
      return args.stats?.assembleDimensions();
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
    args.stats?.recordRequestedInputs({
      composeCount: composeVolumes.length,
      additionalCount: args.additionalVolumes?.length ?? 0,
      artifactCount: args.artifacts.length,
      dedupedArtifactCount: artifacts.length,
    });

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
      stats: args.stats,
    });

    return await assembleStorageManifest({
      ...entries,
      timing: args.timing,
      stats: args.stats,
    });
  });
}
