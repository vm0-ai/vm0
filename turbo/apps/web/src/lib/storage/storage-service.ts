import { resolveVolumes } from "./storage-resolver";
import { generatePresignedUrl, listS3Objects } from "../s3/s3-client";
import { logger } from "../logger";
import { badRequest } from "../errors";
import type {
  AgentVolumeConfig,
  StorageManifest,
  ManifestStorage,
  ManifestArtifact,
} from "./types";
import { storages, storageVersions } from "../../db/schema/storage";
import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { resolveVersionByPrefix, isResolutionError } from "./version-resolver";

const log = logger("storage");

/**
 * Resolve version ID from version string
 * @param userId - User ID for storage access
 * @param storageName - Storage name
 * @param storageType - Storage type ("volume" or "artifact")
 * @param version - Version string ("latest" or specific hash)
 * @returns Version ID and S3 key
 */
async function resolveVersion(
  userId: string,
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
        eq(storages.userId, userId),
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
 * @param userId - User ID for storage access
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
  userId: string,
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

  // Process all volumes and artifact in parallel
  const volumePromises = volumeResult.volumes.map(async (volume) => {
    const { versionId, s3Key } = await resolveVersion(
      userId,
      volume.vasStorageName,
      "volume",
      volume.vasVersion,
    );

    // Generate archive URL for tar.gz
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const archiveUrl = await generatePresignedUrl(bucketName, archiveKey);

    // Get archive size from S3
    const archiveObjects = await listS3Objects(bucketName, archiveKey);
    const archiveSize = archiveObjects[0]?.size ?? 0;

    const manifestStorage: ManifestStorage = {
      name: volume.name,
      mountPath: volume.mountPath,
      vasStorageName: volume.vasStorageName,
      vasVersionId: versionId,
      archiveUrl,
      archiveSize,
    };

    log.debug(`Generated archive URL for volume "${volume.name}"`);

    return manifestStorage;
  });

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
          userId,
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

        // Get archive size from S3
        const archiveObjects = await listS3Objects(bucketName, archiveKey);
        const archiveSize = archiveObjects[0]?.size ?? 0;

        const manifestArtifact: ManifestArtifact = {
          mountPath: artifactSource.mountPath,
          vasStorageName: artifactSource.vasStorageName,
          vasVersionId: versionId,
          archiveUrl,
          archiveSize,
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

  log.debug(
    `Storage manifest prepared: ${storageResults.length} storages, ${artifact ? "1 artifact" : "no artifact"}`,
  );

  return {
    storages: storageResults,
    artifact,
  };
}
