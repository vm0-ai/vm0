import { gzipSync } from "node:zlib";
import { resolveVolumes } from "./storage-resolver";
import { generatePresignedUrl, putS3Object } from "../s3/s3-client";
import { logger } from "../../shared/logger";
import { badRequest } from "../../shared/errors";
import {
  DEFAULT_MEMORY_MOUNT_PATH,
  type AgentVolumeConfig,
  type StorageManifest,
  type ManifestStorage,
  type ManifestArtifact,
} from "./types";
import { storages, storageVersions } from "../../../db/schema/storage";
import { eq, and, isNull } from "drizzle-orm";
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

/**
 * Prepare storage manifest with presigned URLs for direct download to sandbox
 * This method generates presigned URLs instead of downloading files to local temp
 *
 * @param agentConfig - Agent configuration containing volume definitions
 * @param vars - Template variables for placeholder replacement
 * @param agentClerkOrgId - Agent Clerk org ID for volume resolution (where the agent is defined)
 * @param runtimeClerkOrgId - Runtime Clerk org ID for artifact/memory resolution (where the agent is executed)
 * @param userId - User ID within the runtime org (for artifact/memory ownership)
 * @param artifactName - Artifact storage name
 * @param artifactVersion - Artifact version (defaults to "latest")
 * @param volumeVersionOverrides - Optional volume version overrides
 * @param resumeArtifact - Optional artifact snapshot for resume (overrides artifactName/artifactVersion)
 * @param resumeArtifactMountPath - Mount path for resume artifact
 * @param memoryName - Optional memory storage name (mounted at DEFAULT_MEMORY_MOUNT_PATH)
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
  memoryName?: string,
): Promise<StorageManifest> {
  log.debug("Preparing storage manifest with presigned URLs...");

  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

  // For resume scenario, use resumeArtifact; otherwise use artifactName/artifactVersion
  const effectiveArtifactName = resumeArtifact?.artifactName ?? artifactName;
  const effectiveArtifactVersion =
    resumeArtifact?.artifactVersion ?? artifactVersion;
  // Skip artifact in resolveVolumes if we're using resumeArtifact (we'll handle it separately)
  const skipArtifact = !!resumeArtifact;

  // If no agent config and no resume artifact and no memory, return empty manifest
  if (!agentConfig && !resumeArtifact && !memoryName) {
    return { storages: [], artifact: null, memory: null };
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

  // Process all volumes in parallel, handling optional volumes gracefully
  const volumePromises = volumeResult.volumes.map(
    async (volume): Promise<ManifestStorage | null> => {
      // For checkpoint resume: if volumeVersionOverrides is provided and volume is optional
      // but NOT in the overrides, skip it (it was skipped at checkpoint time)
      if (
        volumeVersionOverrides &&
        volume.optional &&
        !(volume.name in volumeVersionOverrides)
      ) {
        return null;
      }

      try {
        // Skill volumes: try system org first (pre-cached official skills),
        // then fall back to agent org (old CLI uploads, third-party skills)
        const isSkill = volume.vasStorageName.startsWith("agent-skills@");
        let resolved: { versionId: string; s3Key: string } | undefined;

        if (isSkill) {
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
            // System org miss — fall through to agent org
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

        const { versionId, s3Key } = resolved;

        // Generate archive URL for tar.gz
        const archiveKey = `${s3Key}/archive.tar.gz`;
        const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);

        const manifestStorage: ManifestStorage = {
          name: volume.name,
          mountPath: volume.mountPath,
          vasStorageName: volume.vasStorageName,
          vasVersionId: versionId,
          archiveUrl,
        };

        log.debug(`Generated archive URL for volume "${volume.name}"`);

        return manifestStorage;
      } catch (error) {
        // For optional volumes, skip if not found
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
        // Re-throw for required volumes
        throw error;
      }
    },
  );

  // Handle artifact: either from resumeArtifact or from volumeResult
  // Note: resumeArtifactMountPath is required when resumeArtifact is provided (no fallback)
  let artifactSource = volumeResult.artifact;
  if (resumeArtifact) {
    if (!resumeArtifactMountPath) {
      throw badRequest(
        "resumeArtifactMountPath is required when resumeArtifact is provided (working_dir must be configured)",
      );
    }
    artifactSource = {
      driver: "vas" as const,
      vasStorageName: resumeArtifact.artifactName,
      vasVersion: resumeArtifact.artifactVersion,
      mountPath: resumeArtifactMountPath,
    };
  }

  const artifactPromise = artifactSource
    ? (async () => {
        const { versionId, s3Key } = await resolveVersion(
          runtimeClerkOrgId,
          artifactSource.vasStorageName,
          "artifact",
          artifactSource.vasVersion,
          userId,
        );

        // Generate archive URL for tar.gz
        const archiveKey = `${s3Key}/archive.tar.gz`;
        const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);

        // Generate manifest URL for incremental upload support
        const manifestKey = `${s3Key}/manifest.json`;
        const manifestUrl = await generatePresignedUrl(bucketName, manifestKey);

        const manifestArtifact: ManifestArtifact = {
          mountPath: artifactSource.mountPath,
          vasStorageName: artifactSource.vasStorageName,
          vasVersionId: versionId,
          archiveUrl,
          manifestUrl,
        };

        log.debug(
          `Generated archive URL for artifact "${artifactSource.vasStorageName}"`,
        );

        return manifestArtifact;
      })()
    : Promise.resolve(null);

  // Resolve memory (uses runtime org, same as artifact)
  // Memory storage is guaranteed to exist after ensureStorageExists() in prepareForExecution()
  const memoryPromise = memoryName
    ? (async (): Promise<ManifestArtifact | null> => {
        const { versionId, s3Key } = await resolveVersion(
          runtimeClerkOrgId,
          memoryName,
          "memory",
          "latest",
          userId,
        );

        const archiveKey = `${s3Key}/archive.tar.gz`;
        const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);

        const memoryArtifact: ManifestArtifact = {
          mountPath: DEFAULT_MEMORY_MOUNT_PATH,
          vasStorageName: memoryName,
          vasVersionId: versionId,
          archiveUrl,
        };

        log.debug(`Generated archive URL for memory "${memoryName}"`);
        return memoryArtifact;
      })()
    : Promise.resolve(null);

  // Wait for all URL generation to complete in parallel
  const [storageResults, artifact, memory] = await Promise.all([
    Promise.all(volumePromises),
    artifactPromise,
    memoryPromise,
  ]);

  // Filter out null results (skipped optional volumes)
  const filteredStorages = storageResults.filter((s): s is ManifestStorage => {
    return s !== null;
  });

  log.debug(
    `Storage manifest prepared: ${filteredStorages.length} storages, ${artifact ? "1 artifact" : "no artifact"}, ${memory ? "1 memory" : "no memory"}`,
  );

  return {
    storages: filteredStorages,
    artifact,
    memory,
  };
}
