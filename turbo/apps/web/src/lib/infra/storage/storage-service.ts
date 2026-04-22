import { gzipSync } from "node:zlib";
import { resolveVolumes } from "./storage-resolver";
import { generatePresignedUrl, putS3Object } from "../s3/s3-client";
import { logger } from "../../shared/logger";
import { badRequest } from "../../shared/errors";
import {
  type AdditionalArtifact,
  type AdditionalVolume,
  type AgentVolumeConfig,
  type ResolvedArtifact,
  type ResolvedVolume,
  type StorageManifest,
  type ManifestStorage,
  type ManifestArtifact,
} from "./types";
import { storages, storageVersions } from "../../../db/schema/storage";
import { eq, and, isNull, sql } from "drizzle-orm";
import { env } from "../../../env";
import { resolveVersionByPrefix, isResolutionError } from "./version-resolver";
import { computeContentHashFromHashes } from "./content-hash";
import { VOLUME_ORG_USER_ID, SYSTEM_ORG_ID } from "@vm0/core";

const log = logger("storage");

/** Create a minimal valid empty tar.gz (two 512-byte null end-of-archive blocks, gzipped) */
function createEmptyTarGz(): Buffer {
  return gzipSync(Buffer.alloc(1024, 0));
}

/**
 * Ensure a storage exists with at least one version.
 * If the storage record doesn't exist, creates it.
 * If it exists but has no HEAD version, creates an empty initial version
 * (both manifest.json and archive.tar.gz so download.ts can create the mount directory).
 * If it already has a HEAD version, this is a no-op.
 *
 * @param orgId - Clerk org ID for storage access
 * @param userId - User ID for storage record ownership
 * @param storageName - Storage name
 * @param storageType - Storage type ("artifact" or "memory")
 */
export async function ensureStorageExists(
  orgId: string,
  userId: string,
  storageName: string,
  storageType: "artifact" | "memory",
): Promise<void> {
  // Find or create storage record (artifact/memory use real userId)
  let [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, userId),
        eq(storages.name, storageName),
        eq(storages.type, storageType),
      ),
    )
    .limit(1);

  if (!storage) {
    const [newStorage] = await globalThis.services.db
      .insert(storages)
      .values({
        name: storageName,
        type: storageType,
        userId,
        s3Prefix: `${orgId}/${storageType}/${storageName}`,
        size: 0,
        fileCount: 0,
        orgId,
      })
      .onConflictDoNothing()
      .returning();

    if (!newStorage) {
      // Race condition: another request created it. Re-fetch.
      const [existing] = await globalThis.services.db
        .select()
        .from(storages)
        .where(
          and(
            eq(storages.orgId, orgId),
            eq(storages.userId, userId),
            eq(storages.name, storageName),
            eq(storages.type, storageType),
          ),
        )
        .limit(1);
      storage = existing;
    } else {
      storage = newStorage;
    }
    log.info("Auto-created storage", { storageName, storageType, orgId });
  }

  if (!storage) {
    throw new Error(
      `Failed to create or fetch ${storageType} storage "${storageName}"`,
    );
  }

  // If HEAD version already exists, nothing more to do
  if (storage.headVersionId) return;

  // Create initial empty version
  const storageId = storage.id;
  try {
    const versionId = computeContentHashFromHashes(storageId, []);
    const s3Key = `${storage.s3Prefix}/${versionId}`;
    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

    await Promise.all([
      putS3Object(
        bucketName,
        manifestKey,
        JSON.stringify({ files: [] }),
        "application/json",
      ),
      putS3Object(
        bucketName,
        archiveKey,
        createEmptyTarGz(),
        "application/gzip",
      ),
    ]);

    await globalThis.services.db.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId,
          s3Key,
          size: 0,
          fileCount: 0,
          message: `Initial empty ${storageType} (auto-created)`,
          createdBy: "user",
        })
        .onConflictDoNothing();

      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: 0,
          fileCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storageId));
    });

    log.info("Auto-created initial storage version", {
      storageName,
      storageType,
      versionId,
    });
  } catch (err) {
    log.error("Failed to create initial storage version", {
      storageName,
      storageType,
      err,
    });
    // Clean up the headless storage so the next call can retry
    await globalThis.services.db
      .delete(storages)
      .where(and(eq(storages.id, storageId), isNull(storages.headVersionId)))
      .catch((cleanupErr) => {
        log.error("Failed to clean up headless storage", { cleanupErr });
      });
    throw err;
  }
}

/**
 * Resolve version ID from version string
 * @param orgId - Clerk org ID for storage access
 * @param storageName - Storage name
 * @param storageType - Storage type ("volume", "artifact", or "memory")
 * @param version - Version string ("latest" or specific hash)
 * @param userId - User ID (real userId for artifact/memory, VOLUME_ORG_USER_ID for volumes)
 * @returns Version ID and S3 key
 */
async function resolveVersion(
  orgId: string,
  storageName: string,
  storageType: "volume" | "artifact" | "memory",
  version: string,
  userId: string,
): Promise<{ versionId: string; s3Key: string }> {
  if (version === "latest") {
    // Fetch storage + HEAD version in a single JOIN query
    const [result] = await globalThis.services.db
      .select({
        headVersionId: storages.headVersionId,
        versionId: storageVersions.id,
        s3Key: storageVersions.s3Key,
      })
      .from(storages)
      .leftJoin(storageVersions, eq(storages.headVersionId, storageVersions.id))
      .where(
        and(
          eq(storages.orgId, orgId),
          eq(storages.userId, userId),
          eq(storages.name, storageName),
          eq(storages.type, storageType),
        ),
      )
      .limit(1);

    if (!result) {
      throw new Error(`Storage "${storageName}" not found in database`);
    }

    if (!result.headVersionId) {
      throw new Error(`Storage "${storageName}" has no HEAD version`);
    }

    if (!result.versionId || !result.s3Key) {
      throw new Error(`Storage "${storageName}" HEAD version not found`);
    }

    return { versionId: result.versionId, s3Key: result.s3Key };
  }

  // For non-latest versions, need storage ID first for prefix resolution
  const [dbStorage] = await globalThis.services.db
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, userId),
        eq(storages.name, storageName),
        eq(storages.type, storageType),
      ),
    )
    .limit(1);

  if (!dbStorage) {
    throw new Error(`Storage "${storageName}" not found in database`);
  }

  // Use shared version resolver for exact match and prefix match
  const result = await resolveVersionByPrefix(dbStorage.id, version);

  if (isResolutionError(result)) {
    // Add storage name context to error message
    if (result.error.includes("not found")) {
      throw new Error(
        `Storage "${storageName}" version "${version}" not found`,
      );
    }
    if (result.error.includes("Ambiguous")) {
      throw new Error(
        `Ambiguous version prefix "${version}" for storage "${storageName}". Please use more characters.`,
      );
    }
    throw new Error(result.error);
  }

  return { versionId: result.version.id, s3Key: result.version.s3Key };
}

interface StorageLookup {
  orgId: string;
  userId: string;
  name: string;
  type: "volume" | "artifact" | "memory";
}

function lookupKey(
  orgId: string,
  userId: string,
  name: string,
  type: string,
): string {
  return `${orgId}:${userId}:${name}:${type}`;
}

/**
 * Batch-resolve HEAD versions for multiple storages in a single query.
 * Uses a composite IN clause on the (orgId, userId, name, type) unique index.
 * Storages that don't exist or have no HEAD version are silently omitted.
 */
async function batchResolveLatestVersions(
  lookups: StorageLookup[],
): Promise<Map<string, { versionId: string; s3Key: string }>> {
  if (lookups.length === 0) return new Map();

  const tuples = lookups.map((l) => {
    return sql`(${l.orgId}, ${l.userId}, ${l.name}, ${l.type})`;
  });

  const rows = await globalThis.services.db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      type: storages.type,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
    })
    .from(storages)
    .leftJoin(storageVersions, eq(storages.headVersionId, storageVersions.id))
    .where(
      sql`(${storages.orgId}, ${storages.userId}, ${storages.name}, ${storages.type}) IN (${sql.join(tuples, sql`, `)})`,
    );

  const result = new Map<string, { versionId: string; s3Key: string }>();
  for (const row of rows) {
    if (row.versionId && row.s3Key) {
      result.set(lookupKey(row.orgId, row.userId, row.name, row.type), {
        versionId: row.versionId,
        s3Key: row.s3Key,
      });
    }
  }
  return result;
}

/**
 * Process a single additional volume: resolve version from runtime org and generate presigned URL.
 * Always optional — returns null if the volume is not found.
 */
async function resolveAdditionalVolume(
  vol: AdditionalVolume,
  runtimeClerkOrgId: string,
  bucketName: string,
): Promise<ManifestStorage | null> {
  const version = vol.version || "latest";
  try {
    let resolved: { versionId: string; s3Key: string } | undefined;

    if (vol.system) {
      try {
        resolved = await resolveVersion(
          SYSTEM_ORG_ID,
          vol.name,
          "volume",
          version,
          VOLUME_ORG_USER_ID,
        );
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("not found"))) {
          throw error;
        }
        // System org miss — fall through to runtime org
      }
    }

    if (!resolved) {
      resolved = await resolveVersion(
        runtimeClerkOrgId,
        vol.name,
        "volume",
        version,
        VOLUME_ORG_USER_ID,
      );
    }

    const { versionId, s3Key } = resolved;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);
    return {
      name: vol.name,
      mountPath: vol.mountPath,
      vasStorageName: vol.name,
      vasVersionId: versionId,
      archiveUrl,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      log.warn(`Additional volume "${vol.name}" not found, skipping`);
      return null;
    }
    throw error;
  }
}

/**
 * Resolve the primary (compose-derived) artifact to a ManifestArtifact.
 * Uses the batched latest lookup when possible and falls back to an
 * individual resolveVersion call for pinned versions.
 */
async function resolvePrimaryArtifact(
  artifactSource: ResolvedArtifact | null,
  allResults: Map<string, { versionId: string; s3Key: string }>,
  runtimeClerkOrgId: string,
  userId: string,
  bucketName: string,
): Promise<ManifestArtifact | null> {
  if (!artifactSource) return null;

  const isLatest = artifactSource.vasVersion === "latest";
  let versionId: string;
  let s3Key: string;

  if (isLatest) {
    const key = lookupKey(
      runtimeClerkOrgId,
      userId,
      artifactSource.vasStorageName,
      "artifact",
    );
    const resolved = allResults.get(key);
    if (!resolved) {
      throw new Error(
        `Storage "${artifactSource.vasStorageName}" not found in database`,
      );
    }
    versionId = resolved.versionId;
    s3Key = resolved.s3Key;
  } else {
    const resolved = await resolveVersion(
      runtimeClerkOrgId,
      artifactSource.vasStorageName,
      "artifact",
      artifactSource.vasVersion,
      userId,
    );
    versionId = resolved.versionId;
    s3Key = resolved.s3Key;
  }

  const archiveKey = `${s3Key}/archive.tar.gz`;
  const manifestKey = `${s3Key}/manifest.json`;
  const [archiveUrl, manifestUrl] = await Promise.all([
    generatePresignedUrl(bucketName, archiveKey),
    generatePresignedUrl(bucketName, manifestKey),
  ]);
  log.debug(
    `Generated archive URL for artifact "${artifactSource.vasStorageName}"`,
  );
  return {
    mountPath: artifactSource.mountPath,
    vasStorageName: artifactSource.vasStorageName,
    vasVersionId: versionId,
    archiveUrl,
    manifestUrl,
  };
}

/**
 * Resolve a single additional artifact by name/version against the runtime
 * org, returning a ManifestArtifact with presigned URLs. Missing storages
 * bubble up — additional artifacts are treated as required (unlike additional
 * volumes) because the caller explicitly opted them in by name.
 */
async function resolveAdditionalArtifact(
  entry: AdditionalArtifact,
  runtimeClerkOrgId: string,
  userId: string,
  bucketName: string,
): Promise<ManifestArtifact> {
  const version = entry.version || "latest";
  let resolved: { versionId: string; s3Key: string };
  try {
    resolved = await resolveVersion(
      runtimeClerkOrgId,
      entry.name,
      "artifact",
      version,
      userId,
    );
  } catch (err) {
    // Dual-read compat for epic #10577 Phase 2 type flip (#10601):
    // fall back to type='memory' for storages not yet flipped. Any artifact
    // row missing under type='artifact' is retried as type='memory'; in
    // practice only legacy memory storages match. Removed in #10603.
    if (!(err instanceof Error && err.message.includes("not found"))) {
      throw err;
    }
    log.info("memory dual-read fallback hit", {
      name: entry.name,
      orgId: runtimeClerkOrgId,
      userId,
    });
    resolved = await resolveVersion(
      runtimeClerkOrgId,
      entry.name,
      "memory",
      version,
      userId,
    );
  }
  const { versionId, s3Key } = resolved;
  const archiveKey = `${s3Key}/archive.tar.gz`;
  const manifestKey = `${s3Key}/manifest.json`;
  const [archiveUrl, manifestUrl] = await Promise.all([
    generatePresignedUrl(bucketName, archiveKey),
    generatePresignedUrl(bucketName, manifestKey),
  ]);
  return {
    mountPath: entry.mountPath,
    vasStorageName: entry.name,
    vasVersionId: versionId,
    archiveUrl,
    manifestUrl,
  };
}

/**
 * Determine the artifact source: use resumeArtifact if provided, otherwise fall back to resolved artifact.
 */
function resolveArtifactSource(
  resolvedArtifact: ResolvedArtifact | null,
  resumeArtifact: { artifactName: string; artifactVersion: string } | undefined,
  resumeArtifactMountPath: string | undefined,
): ResolvedArtifact | null {
  if (!resumeArtifact) return resolvedArtifact;
  if (!resumeArtifactMountPath) {
    throw badRequest(
      "resumeArtifactMountPath is required when resumeArtifact is provided (working_dir must be configured)",
    );
  }
  return {
    driver: "vas" as const,
    vasStorageName: resumeArtifact.artifactName,
    vasVersion: resumeArtifact.artifactVersion,
    mountPath: resumeArtifactMountPath,
  };
}

/**
 * Prepare storage manifest with presigned URLs for direct download to sandbox
 * This method generates presigned URLs instead of downloading files to local temp
 *
 * @param agentConfig - Agent configuration containing volume definitions
 * @param vars - Template variables for placeholder replacement
 * @param agentClerkOrgId - Agent Clerk org ID for volume resolution (where the agent is defined)
 * @param runtimeClerkOrgId - Runtime Clerk org ID for artifact resolution (where the agent is executed)
 * @param userId - User ID within the runtime org (for artifact ownership)
 * @param artifactName - Artifact storage name
 * @param artifactVersion - Artifact version (defaults to "latest")
 * @param volumeVersionOverrides - Optional volume version overrides
 * @param resumeArtifact - Optional artifact snapshot for resume (overrides artifactName/artifactVersion)
 * @param resumeArtifactMountPath - Mount path for resume artifact
 * @returns Storage manifest with presigned URLs
 */
export async function prepareStorageManifest(
  agentConfig: AgentVolumeConfig | undefined,
  vars: Record<string, string>,
  agentClerkOrgId: string,
  runtimeClerkOrgId: string,
  userId: string,
  artifactName?: string,
  artifactVersion?: string,
  volumeVersionOverrides?: Record<string, string>,
  resumeArtifact?: { artifactName: string; artifactVersion: string },
  resumeArtifactMountPath?: string,
  additionalVolumes?: AdditionalVolume[],
  additionalArtifacts?: AdditionalArtifact[],
): Promise<StorageManifest> {
  log.debug("Preparing storage manifest with presigned URLs...");

  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

  // For resume scenario, use resumeArtifact; otherwise use artifactName/artifactVersion
  const effectiveArtifactName = resumeArtifact?.artifactName ?? artifactName;
  const effectiveArtifactVersion =
    resumeArtifact?.artifactVersion ?? artifactVersion;
  // Skip artifact in resolveVolumes if we're using resumeArtifact (we'll handle it separately)
  const skipArtifact = !!resumeArtifact;

  // If no agent config and no resume artifact and no additional volumes/artifacts, return empty manifest
  if (
    !agentConfig &&
    !resumeArtifact &&
    (!additionalVolumes || additionalVolumes.length === 0) &&
    (!additionalArtifacts || additionalArtifacts.length === 0)
  ) {
    return { storages: [], artifacts: [], memory: null };
  }

  // Resolve volumes from agent config.
  // resumeArtifactMountPath is the working directory from the previous run's artifact,
  // used as workingDir for artifact mount path resolution during checkpoint resume.
  const volumeResult = agentConfig
    ? resolveVolumes(
        agentConfig,
        vars,
        skipArtifact ? undefined : effectiveArtifactName,
        skipArtifact ? undefined : effectiveArtifactVersion,
        skipArtifact,
        volumeVersionOverrides,
        resumeArtifactMountPath,
      )
    : { volumes: [], artifact: null, errors: [] };

  // Check for volume resolution errors (missing variables, invalid config, etc.)
  if (volumeResult.errors.length > 0) {
    const messages = volumeResult.errors
      .map((e) => {
        return e.message;
      })
      .join("; ");
    throw new Error(`Volume resolution failed: ${messages}`);
  }

  // Handle artifact: either from resumeArtifact or from volumeResult
  const artifactSource = resolveArtifactSource(
    volumeResult.artifact,
    resumeArtifact,
    resumeArtifactMountPath,
  );

  // Partition volumes into batch-eligible and individual-resolve groups
  const partitioned = partitionVolumes(
    volumeResult.volumes,
    additionalVolumes ?? [],
    volumeVersionOverrides,
  );

  // Two-phase batch resolution: system org first, then remaining orgs
  const allResults = await executeBatchResolution(
    partitioned,
    agentClerkOrgId,
    runtimeClerkOrgId,
    userId,
    artifactSource,
  );

  // Resolve non-latest volumes individually (rare: explicit version overrides)
  const nonLatestResolved = await resolveNonLatestVolumes(
    partitioned.nonLatestVolumes,
    agentClerkOrgId,
    bucketName,
  );

  const nonLatestAdditionalResolved = await Promise.all(
    partitioned.nonLatestAdditional.map((vol) => {
      return resolveAdditionalVolume(vol, runtimeClerkOrgId, bucketName);
    }),
  );

  // Resolve additional artifacts in parallel. These are always resolved
  // individually (no batching) because the list is typically small and each
  // entry carries an explicit mountPath, so there's no shared agent/system
  // fallback path to optimize.
  const resolvedAdditionalArtifacts = await Promise.all(
    (additionalArtifacts ?? []).map((entry) => {
      return resolveAdditionalArtifact(
        entry,
        runtimeClerkOrgId,
        userId,
        bucketName,
      );
    }),
  );

  // Map batch results to manifest entries
  const manifest = await buildManifestFromResults(
    allResults,
    partitioned,
    agentClerkOrgId,
    runtimeClerkOrgId,
    userId,
    bucketName,
    artifactSource,
    nonLatestResolved,
    nonLatestAdditionalResolved,
  );

  if (resolvedAdditionalArtifacts.length === 0) return manifest;

  // Merge additional artifacts, deduplicating by mount path. Additional
  // artifacts override any primary artifact mounted at the same path.
  const additionalMountPaths = new Set(
    resolvedAdditionalArtifacts.map((a) => {
      return a.mountPath;
    }),
  );
  const filteredArtifacts = manifest.artifacts.filter((a) => {
    return !additionalMountPaths.has(a.mountPath);
  });
  return {
    ...manifest,
    artifacts: [...filteredArtifacts, ...resolvedAdditionalArtifacts],
  };
}

/** Partitioned volumes for batch vs individual resolution */
interface PartitionedVolumes {
  latestSystemComposeVolumes: ResolvedVolume[];
  latestNonSystemComposeVolumes: ResolvedVolume[];
  nonLatestVolumes: ResolvedVolume[];
  latestSystemAdditional: AdditionalVolume[];
  latestNonSystemAdditional: AdditionalVolume[];
  nonLatestAdditional: AdditionalVolume[];
}

/**
 * Partition volumes into groups for batch vs individual resolution.
 */
function partitionVolumes(
  volumes: ResolvedVolume[],
  additionalVolumes: AdditionalVolume[],
  volumeVersionOverrides: Record<string, string> | undefined,
): PartitionedVolumes {
  const latestSystemComposeVolumes: ResolvedVolume[] = [];
  const latestNonSystemComposeVolumes: ResolvedVolume[] = [];
  const nonLatestVolumes: ResolvedVolume[] = [];

  for (const volume of volumes) {
    // Checkpoint resume: skip optional volumes not in overrides
    if (
      volumeVersionOverrides &&
      volume.optional &&
      !(volume.name in volumeVersionOverrides)
    ) {
      continue;
    }

    if (volume.vasVersion !== "latest") {
      nonLatestVolumes.push(volume);
    } else if (volume.system === true) {
      latestSystemComposeVolumes.push(volume);
    } else {
      latestNonSystemComposeVolumes.push(volume);
    }
  }

  const latestSystemAdditional: AdditionalVolume[] = [];
  const latestNonSystemAdditional: AdditionalVolume[] = [];
  const nonLatestAdditional: AdditionalVolume[] = [];

  for (const vol of additionalVolumes) {
    const version = vol.version || "latest";
    if (version !== "latest") {
      nonLatestAdditional.push(vol);
    } else if (vol.system) {
      latestSystemAdditional.push(vol);
    } else {
      latestNonSystemAdditional.push(vol);
    }
  }

  return {
    latestSystemComposeVolumes,
    latestNonSystemComposeVolumes,
    nonLatestVolumes,
    latestSystemAdditional,
    latestNonSystemAdditional,
    nonLatestAdditional,
  };
}

/** Build a volume lookup for the system org */
function systemVolumeLookup(name: string): StorageLookup {
  return {
    orgId: SYSTEM_ORG_ID,
    userId: VOLUME_ORG_USER_ID,
    name,
    type: "volume",
  };
}

/** Build a volume lookup for a specific org */
function orgVolumeLookup(orgId: string, name: string): StorageLookup {
  return { orgId, userId: VOLUME_ORG_USER_ID, name, type: "volume" };
}

/**
 * Execute two-phase batch resolution: system org first, then remaining orgs.
 * Returns merged results map.
 */
async function executeBatchResolution(
  partitioned: PartitionedVolumes,
  agentClerkOrgId: string,
  runtimeClerkOrgId: string,
  userId: string,
  artifactSource: ResolvedArtifact | null,
): Promise<Map<string, { versionId: string; s3Key: string }>> {
  // Phase 1: System org batch (system compose volumes + system additional volumes)
  const systemLookups: StorageLookup[] = [
    ...partitioned.latestSystemComposeVolumes.map((v) => {
      return systemVolumeLookup(v.vasStorageName);
    }),
    ...partitioned.latestSystemAdditional.map((v) => {
      return systemVolumeLookup(v.name);
    }),
  ];

  const systemResults = await batchResolveLatestVersions(systemLookups);

  // Identify misses for fallback
  const systemComposeMisses = partitioned.latestSystemComposeVolumes.filter(
    (v) => {
      return !systemResults.has(
        lookupKey(
          SYSTEM_ORG_ID,
          VOLUME_ORG_USER_ID,
          v.vasStorageName,
          "volume",
        ),
      );
    },
  );
  const systemAdditionalMisses = partitioned.latestSystemAdditional.filter(
    (v) => {
      return !systemResults.has(
        lookupKey(SYSTEM_ORG_ID, VOLUME_ORG_USER_ID, v.name, "volume"),
      );
    },
  );

  // Phase 2: Remaining lookups (non-system compose volumes, misses, additional, artifact, memory)
  const remainingLookups: StorageLookup[] = [
    ...partitioned.latestNonSystemComposeVolumes.map((v) => {
      return orgVolumeLookup(agentClerkOrgId, v.vasStorageName);
    }),
    ...systemComposeMisses.map((v) => {
      return orgVolumeLookup(agentClerkOrgId, v.vasStorageName);
    }),
    ...systemAdditionalMisses.map((v) => {
      return orgVolumeLookup(runtimeClerkOrgId, v.name);
    }),
    ...partitioned.latestNonSystemAdditional.map((v) => {
      return orgVolumeLookup(runtimeClerkOrgId, v.name);
    }),
  ];

  if (artifactSource && artifactSource.vasVersion === "latest") {
    remainingLookups.push({
      orgId: runtimeClerkOrgId,
      userId,
      name: artifactSource.vasStorageName,
      type: "artifact",
    });
  }

  const remainingResults = await batchResolveLatestVersions(remainingLookups);

  // Merge: system results take precedence for found items
  return new Map([...remainingResults, ...systemResults]);
}

/**
 * Resolve non-latest volumes individually (rare: explicit version overrides).
 */
async function resolveNonLatestVolumes(
  volumes: ResolvedVolume[],
  agentClerkOrgId: string,
  bucketName: string,
): Promise<(ManifestStorage | null)[]> {
  return Promise.all(
    volumes.map(async (volume) => {
      try {
        let resolved: { versionId: string; s3Key: string } | undefined;

        if (volume.system === true) {
          try {
            resolved = await resolveVersion(
              SYSTEM_ORG_ID,
              volume.vasStorageName,
              "volume",
              volume.vasVersion,
              VOLUME_ORG_USER_ID,
            );
          } catch (error) {
            if (
              !(error instanceof Error && error.message.includes("not found"))
            ) {
              throw error;
            }
          }
        }

        if (!resolved) {
          resolved = await resolveVersion(
            agentClerkOrgId,
            volume.vasStorageName,
            "volume",
            volume.vasVersion,
            VOLUME_ORG_USER_ID,
          );
        }

        const archiveKey = `${resolved.s3Key}/archive.tar.gz`;
        const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);
        return {
          name: volume.name,
          mountPath: volume.mountPath,
          vasStorageName: volume.vasStorageName,
          vasVersionId: resolved.versionId,
          archiveUrl,
        } satisfies ManifestStorage;
      } catch (error) {
        if (
          volume.optional &&
          error instanceof Error &&
          error.message.includes("not found")
        ) {
          log.warn(
            `Optional volume "${volume.vasStorageName}" not found, skipping`,
          );
          return null;
        }
        throw error;
      }
    }),
  );
}

/** Generate a ManifestStorage from a batch-resolved result */
async function buildStorageEntry(
  bucketName: string,
  name: string,
  mountPath: string,
  vasStorageName: string,
  resolved: { versionId: string; s3Key: string },
): Promise<ManifestStorage> {
  const archiveKey = `${resolved.s3Key}/archive.tar.gz`;
  const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);
  return {
    name,
    mountPath,
    vasStorageName,
    vasVersionId: resolved.versionId,
    archiveUrl,
  };
}

/**
 * Look up a volume result, trying primary key first, then fallback key.
 */
function lookupWithFallback(
  allResults: Map<string, { versionId: string; s3Key: string }>,
  primaryKey: string,
  fallbackKey: string,
): { versionId: string; s3Key: string } | undefined {
  return allResults.get(primaryKey) ?? allResults.get(fallbackKey);
}

/**
 * Build storage manifest from batch results and individually-resolved entries.
 */
async function buildManifestFromResults(
  allResults: Map<string, { versionId: string; s3Key: string }>,
  partitioned: PartitionedVolumes,
  agentClerkOrgId: string,
  runtimeClerkOrgId: string,
  userId: string,
  bucketName: string,
  artifactSource: ResolvedArtifact | null,
  nonLatestResolved: (ManifestStorage | null)[],
  nonLatestAdditionalResolved: (ManifestStorage | null)[],
): Promise<StorageManifest> {
  const composeEntryPromises: Promise<ManifestStorage>[] = [];

  // System-flagged compose volumes: try system org, then agent org
  for (const volume of partitioned.latestSystemComposeVolumes) {
    const resolved = lookupWithFallback(
      allResults,
      lookupKey(
        SYSTEM_ORG_ID,
        VOLUME_ORG_USER_ID,
        volume.vasStorageName,
        "volume",
      ),
      lookupKey(
        agentClerkOrgId,
        VOLUME_ORG_USER_ID,
        volume.vasStorageName,
        "volume",
      ),
    );

    if (resolved) {
      composeEntryPromises.push(
        buildStorageEntry(
          bucketName,
          volume.name,
          volume.mountPath,
          volume.vasStorageName,
          resolved,
        ),
      );
    } else if (!volume.optional) {
      throw new Error(
        `Storage "${volume.vasStorageName}" not found in database`,
      );
    } else {
      log.warn(
        `Optional volume "${volume.vasStorageName}" not found, skipping`,
      );
    }
  }

  // Non-system compose volumes: agent org only
  for (const volume of partitioned.latestNonSystemComposeVolumes) {
    const key = lookupKey(
      agentClerkOrgId,
      VOLUME_ORG_USER_ID,
      volume.vasStorageName,
      "volume",
    );
    const resolved = allResults.get(key);

    if (resolved) {
      composeEntryPromises.push(
        buildStorageEntry(
          bucketName,
          volume.name,
          volume.mountPath,
          volume.vasStorageName,
          resolved,
        ),
      );
    } else if (!volume.optional) {
      throw new Error(
        `Storage "${volume.vasStorageName}" not found in database`,
      );
    } else {
      log.warn(
        `Optional volume "${volume.vasStorageName}" not found, skipping`,
      );
    }
  }

  // Additional volumes: system org with runtime fallback, or runtime only
  const additionalEntryPromises: Promise<ManifestStorage>[] = [];

  for (const vol of partitioned.latestSystemAdditional) {
    const resolved = lookupWithFallback(
      allResults,
      lookupKey(SYSTEM_ORG_ID, VOLUME_ORG_USER_ID, vol.name, "volume"),
      lookupKey(runtimeClerkOrgId, VOLUME_ORG_USER_ID, vol.name, "volume"),
    );
    if (resolved) {
      additionalEntryPromises.push(
        buildStorageEntry(
          bucketName,
          vol.name,
          vol.mountPath,
          vol.name,
          resolved,
        ),
      );
    } else {
      log.warn(`Additional volume "${vol.name}" not found, skipping`);
    }
  }

  for (const vol of partitioned.latestNonSystemAdditional) {
    const key = lookupKey(
      runtimeClerkOrgId,
      VOLUME_ORG_USER_ID,
      vol.name,
      "volume",
    );
    const resolved = allResults.get(key);
    if (resolved) {
      additionalEntryPromises.push(
        buildStorageEntry(
          bucketName,
          vol.name,
          vol.mountPath,
          vol.name,
          resolved,
        ),
      );
    } else {
      log.warn(`Additional volume "${vol.name}" not found, skipping`);
    }
  }

  // Resolve all presigned URLs in parallel
  const [composeEntries, additionalEntries] = await Promise.all([
    Promise.all(composeEntryPromises),
    Promise.all(additionalEntryPromises),
  ]);

  const composeStorages = [
    ...composeEntries,
    ...nonLatestResolved.filter((s): s is ManifestStorage => {
      return s !== null;
    }),
  ];

  const resolvedAdditional = [
    ...additionalEntries,
    ...nonLatestAdditionalResolved.filter((s): s is ManifestStorage => {
      return s !== null;
    }),
  ];

  const artifact = await resolvePrimaryArtifact(
    artifactSource,
    allResults,
    runtimeClerkOrgId,
    userId,
    bucketName,
  );

  // Memory is always null post-#10602 — memory now flows through
  // manifest.artifacts[] (zero synthesizes it from memoryName). The slot is
  // retained for runner wire compat and is removed in #10603.
  const memory: ManifestArtifact | null = null;

  // Deduplicate mount paths: additional volumes override compose volumes
  const additionalMountPaths = new Set(
    resolvedAdditional.map((s) => {
      return s.mountPath;
    }),
  );

  const filteredCompose = composeStorages.filter((s) => {
    return !additionalMountPaths.has(s.mountPath);
  });

  const filteredStorages = [...filteredCompose, ...resolvedAdditional];

  log.debug(
    `Storage manifest prepared: ${filteredStorages.length} storages (${filteredCompose.length} compose + ${resolvedAdditional.length} additional), ${artifact ? "1 artifact" : "no artifact"}, ${memory ? "1 memory" : "no memory"}`,
  );

  return {
    storages: filteredStorages,
    artifacts: artifact ? [artifact] : [],
    memory,
  };
}
