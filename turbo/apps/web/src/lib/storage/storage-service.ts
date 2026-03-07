import { resolveVolumes } from "./storage-resolver";
import { generatePresignedUrl, putS3Object } from "../s3/s3-client";
import { logger } from "../logger";
import { badRequest } from "../errors";
import type {
  AgentVolumeConfig,
  StorageManifest,
  ManifestStorage,
  ManifestArtifact,
} from "./types";
import { storages, storageVersions } from "../../db/schema/storage";
import { eq, and, isNull } from "drizzle-orm";
import { env } from "../../env";
import { resolveVersionByPrefix, isResolutionError } from "./version-resolver";
import { computeContentHashFromHashes } from "./content-hash";

const log = logger("storage");

/**
 * Ensure an artifact storage exists with at least one version.
 * If the storage record doesn't exist, creates it.
 * If it exists but has no HEAD version, creates an empty initial version.
 * If it already has a HEAD version, this is a no-op.
 *
 * @param scopeId - Scope ID for storage access
 * @param userId - User ID for storage record ownership
 * @param artifactName - Artifact storage name
 * @param scopeSlug - Scope slug for S3 prefix construction
 */
export async function ensureArtifactExists(
  scopeId: string,
  userId: string,
  artifactName: string,
  scopeSlug: string,
): Promise<void> {
  // Find or create storage record
  let [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.scopeId, scopeId),
        eq(storages.name, artifactName),
        eq(storages.type, "artifact"),
      ),
    )
    .limit(1);

  if (!storage) {
    const [newStorage] = await globalThis.services.db
      .insert(storages)
      .values({
        scopeId,
        name: artifactName,
        type: "artifact",
        userId,
        s3Prefix: `${scopeSlug}/artifact/${artifactName}`,
        size: 0,
        fileCount: 0,
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
            eq(storages.scopeId, scopeId),
            eq(storages.name, artifactName),
            eq(storages.type, "artifact"),
          ),
        )
        .limit(1);
      storage = existing;
    } else {
      storage = newStorage;
    }
    log.info("Auto-created artifact storage", { artifactName, scopeId });
  }

  if (!storage) {
    throw new Error(
      `Failed to create or fetch artifact storage "${artifactName}"`,
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
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

    await putS3Object(
      bucketName,
      manifestKey,
      JSON.stringify({ files: [] }),
      "application/json",
    );

    await globalThis.services.db.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId,
          s3Key,
          size: 0,
          fileCount: 0,
          message: "Initial empty artifact (auto-created)",
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

    log.info("Auto-created initial artifact version", {
      artifactName,
      versionId,
    });
  } catch (err) {
    log.error("Failed to create initial artifact version", { err });
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
 * @param scopeId - Scope ID for storage access
 * @param storageName - Storage name
 * @param storageType - Storage type ("volume" or "artifact")
 * @param version - Version string ("latest" or specific hash)
 * @returns Version ID and S3 key
 */
async function resolveVersion(
  scopeId: string,
  storageName: string,
  storageType: "volume" | "artifact",
  version: string,
): Promise<{ versionId: string; s3Key: string }> {
  // Query database for storage
  // Must include type in query since same name can exist for different types
  const [dbStorage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.scopeId, scopeId),
        eq(storages.name, storageName),
        eq(storages.type, storageType),
      ),
    )
    .limit(1);

  if (!dbStorage) {
    throw new Error(`Storage "${storageName}" not found in database`);
  }

  if (version === "latest") {
    // Get HEAD version
    if (!dbStorage.headVersionId) {
      throw new Error(`Storage "${storageName}" has no HEAD version`);
    }

    const [headVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, dbStorage.headVersionId))
      .limit(1);

    if (!headVersion) {
      throw new Error(`Storage "${storageName}" HEAD version not found`);
    }

    return { versionId: headVersion.id, s3Key: headVersion.s3Key };
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
 * @param volumeScopeId - Scope ID for volume resolution (agent owner's scope)
 * @param artifactScopeId - Scope ID for artifact resolution (runner's scope)
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
  volumeScopeId: string,
  artifactScopeId: string,
  artifactName?: string,
  artifactVersion?: string,
  volumeVersionOverrides?: Record<string, string>,
  resumeArtifact?: { artifactName: string; artifactVersion: string },
  resumeArtifactMountPath?: string,
): Promise<StorageManifest> {
  log.debug("Preparing storage manifest with presigned URLs...");

  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

  // For resume scenario, use resumeArtifact; otherwise use artifactName/artifactVersion
  const effectiveArtifactName = resumeArtifact?.artifactName ?? artifactName;
  const effectiveArtifactVersion =
    resumeArtifact?.artifactVersion ?? artifactVersion;
  // Skip artifact in resolveVolumes if we're using resumeArtifact (we'll handle it separately)
  const skipArtifact = !!resumeArtifact;

  // If no agent config and no resume artifact, return empty manifest
  if (!agentConfig && !resumeArtifact) {
    return { storages: [], artifact: null };
  }

  // Resolve volumes from agent config
  const volumeResult = agentConfig
    ? resolveVolumes(
        agentConfig,
        vars,
        skipArtifact ? undefined : effectiveArtifactName,
        skipArtifact ? undefined : effectiveArtifactVersion,
        skipArtifact,
        volumeVersionOverrides,
      )
    : { volumes: [], artifact: null, errors: [] };

  // Check for volume resolution errors (missing variables, invalid config, etc.)
  if (volumeResult.errors.length > 0) {
    const messages = volumeResult.errors.map((e) => e.message).join("; ");
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
        const { versionId, s3Key } = await resolveVersion(
          volumeScopeId,
          volume.vasStorageName,
          "volume",
          volume.vasVersion,
        );

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
        // For optional volumes, silently skip if not found
        if (
          volume.optional &&
          error instanceof Error &&
          error.message.includes("not found")
        ) {
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
          artifactScopeId,
          artifactSource.vasStorageName,
          "artifact",
          artifactSource.vasVersion,
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

  // Wait for all URL generation to complete in parallel
  const [storageResults, artifact] = await Promise.all([
    Promise.all(volumePromises),
    artifactPromise,
  ]);

  // Filter out null results (skipped optional volumes)
  const filteredStorages = storageResults.filter(
    (s): s is ManifestStorage => s !== null,
  );

  log.debug(
    `Storage manifest prepared: ${filteredStorages.length} storages, ${artifact ? "1 artifact" : "no artifact"}`,
  );

  return {
    storages: filteredStorages,
    artifact,
  };
}
