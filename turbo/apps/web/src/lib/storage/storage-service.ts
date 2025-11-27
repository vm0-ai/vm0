import type { Sandbox } from "@e2b/code-interpreter";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveVolumes } from "./storage-resolver";
import { downloadS3Directory } from "../s3/s3-client";
import type {
  AgentVolumeConfig,
  PreparedStorage,
  PreparedArtifact,
  StoragePreparationResult,
  ResolvedArtifact,
  ResolvedVolume,
} from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import { storages, storageVersions } from "../../db/schema/storage";
import { eq, and } from "drizzle-orm";
import { env } from "../../env";

/**
 * Storage Service
 * Manages storage preparation, mounting, and cleanup operations
 */
export class StorageService {
  /**
   * Resolve version ID from version string
   * @param userId - User ID for storage access
   * @param storageName - Storage name
   * @param version - Version string ("latest" or specific hash)
   * @returns Version ID and S3 key
   */
  private async resolveVersion(
    userId: string,
    storageName: string,
    version: string,
  ): Promise<{ versionId: string; s3Key: string }> {
    // Query database for storage
    const [dbStorage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.name, storageName)))
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

    // Query for specific version by ID (hash)
    const [specificVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, dbStorage.id),
          eq(storageVersions.id, version),
        ),
      )
      .limit(1);

    if (!specificVersion) {
      throw new Error(
        `Storage "${storageName}" version "${version}" not found`,
      );
    }

    return { versionId: specificVersion.id, s3Key: specificVersion.s3Key };
  }

  /**
   * Prepare storages: resolve configurations and download from S3 to temp directory
   * @param agentConfig - Agent configuration containing volume definitions
   * @param templateVars - Template variables for placeholder replacement
   * @param runId - Run ID for temp directory naming
   * @param userId - User ID for storage access
   * @param artifactName - Artifact storage name (required)
   * @param artifactVersion - Artifact version (defaults to "latest")
   * @param skipArtifact - Skip artifact resolution (used when resuming from checkpoint)
   * @returns Storage preparation result with prepared storages and temp directory
   */
  async prepareStorages(
    agentConfig: AgentVolumeConfig | undefined,
    templateVars: Record<string, string>,
    runId: string,
    userId: string,
    artifactName?: string,
    artifactVersion?: string,
    skipArtifact?: boolean,
  ): Promise<StoragePreparationResult> {
    const errors: string[] = [];

    // If no agent config, return empty result
    if (!agentConfig) {
      return {
        preparedStorages: [],
        preparedArtifact: null,
        tempDir: null,
        errors: [],
      };
    }

    // Resolve volumes from agent config
    const volumeResult = resolveVolumes(
      agentConfig,
      templateVars,
      artifactName,
      artifactVersion,
      skipArtifact,
    );

    // Log volume resolution errors but don't fail the preparation
    if (volumeResult.errors.length > 0) {
      console.warn(`[Storage] Volume resolution errors:`, volumeResult.errors);
      errors.push(
        ...volumeResult.errors.map((e) => `${e.volumeName}: ${e.message}`),
      );
    }

    // Check if we need a temp directory (for VAS storages/artifacts)
    const hasVasStorages = volumeResult.volumes.length > 0;
    const hasVasArtifact = volumeResult.artifact !== null;
    const needsTempDir = hasVasStorages || hasVasArtifact;

    let tempDir: string | null = null;
    if (needsTempDir) {
      tempDir = `/tmp/vas-run-${runId}`;
      await fs.promises.mkdir(tempDir, { recursive: true });
    }

    console.log(
      `[Storage] Preparing ${volumeResult.volumes.length} storages and ${volumeResult.artifact ? "1 artifact" : "no artifact"}...`,
    );

    const preparedStorages: PreparedStorage[] = [];
    let preparedArtifact: PreparedArtifact | null = null;

    // Process each volume
    for (const volume of volumeResult.volumes) {
      try {
        const prepared = await this.prepareVolume(volume, tempDir!, userId);
        preparedStorages.push(prepared);
      } catch (error) {
        console.error(
          `[Storage] Failed to prepare storage "${volume.name}":`,
          error,
        );
        errors.push(
          `${volume.name}: Failed to prepare - ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    // Process artifact
    if (volumeResult.artifact) {
      try {
        preparedArtifact = await this.prepareArtifact(
          volumeResult.artifact,
          tempDir!,
          userId,
        );
      } catch (error) {
        console.error(`[Storage] Failed to prepare artifact:`, error);
        errors.push(
          `artifact: Failed to prepare - ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    return {
      preparedStorages,
      preparedArtifact,
      tempDir,
      errors,
    };
  }

  /**
   * Prepare a single volume
   */
  private async prepareVolume(
    volume: ResolvedVolume,
    tempDir: string,
    userId: string,
  ): Promise<PreparedStorage> {
    // Resolve version
    const { versionId, s3Key } = await this.resolveVersion(
      userId,
      volume.vasStorageName,
      volume.vasVersion,
    );

    // Download from S3
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      throw new Error("S3_USER_STORAGES_NAME environment variable is not set");
    }
    const s3Uri = `s3://${bucketName}/${s3Key}`;
    const localPath = path.join(tempDir, volume.name);

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Storage] Downloaded VAS storage "${volume.name}" (${volume.vasStorageName}) version ${versionId}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      name: volume.name,
      driver: "vas",
      localPath,
      mountPath: volume.mountPath,
      vasStorageName: volume.vasStorageName,
      vasVersionId: versionId,
    };
  }

  /**
   * Prepare a single artifact
   */
  private async prepareArtifact(
    artifact: ResolvedArtifact,
    tempDir: string,
    userId: string,
  ): Promise<PreparedArtifact> {
    // Resolve version
    const { versionId, s3Key } = await this.resolveVersion(
      userId,
      artifact.vasStorageName,
      artifact.vasVersion,
    );

    // Download from S3
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      throw new Error("S3_USER_STORAGES_NAME environment variable is not set");
    }
    const s3Uri = `s3://${bucketName}/${s3Key}`;
    const localPath = path.join(tempDir, "artifact");

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Storage] Downloaded VAS artifact (${artifact.vasStorageName}) version ${versionId}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      driver: "vas",
      localPath,
      mountPath: artifact.mountPath,
      vasStorageName: artifact.vasStorageName,
      vasVersionId: versionId,
    };
  }

  /**
   * Prepare artifact from checkpoint snapshot (for resume functionality)
   * @param snapshot - Artifact snapshot from checkpoint (artifactName + artifactVersion)
   * @param mountPath - Mount path for the artifact in sandbox
   * @param runId - Run ID for temp directory naming
   * @param userId - User ID for storage access (required for resolving "latest" version)
   * @returns Prepared artifact
   */
  async prepareArtifactFromSnapshot(
    snapshot: ArtifactSnapshot,
    mountPath: string,
    runId: string,
    userId: string,
  ): Promise<{
    preparedArtifact: PreparedArtifact | null;
    tempDir: string | null;
    errors: string[];
  }> {
    // VAS artifact: download from specific version
    if (!snapshot.artifactVersion) {
      return {
        preparedArtifact: null,
        tempDir: null,
        errors: ["Artifact snapshot missing artifactVersion"],
      };
    }

    console.log(
      `[Storage] Preparing artifact from snapshot: ${snapshot.artifactName}@${snapshot.artifactVersion}`,
    );

    const tempDir = `/tmp/vas-run-${runId}`;
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Resolve version (handles "latest" by looking up HEAD)
    let versionId: string;
    let s3Key: string;
    try {
      const resolved = await this.resolveVersion(
        userId,
        snapshot.artifactName,
        snapshot.artifactVersion,
      );
      versionId = resolved.versionId;
      s3Key = resolved.s3Key;
    } catch (error) {
      return {
        preparedArtifact: null,
        tempDir,
        errors: [
          `Failed to resolve artifact version: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
      };
    }

    // Download from the resolved version's S3 path
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      return {
        preparedArtifact: null,
        tempDir,
        errors: ["S3_USER_STORAGES_NAME environment variable is not set"],
      };
    }
    const s3Uri = `s3://${bucketName}/${s3Key}`;
    const localPath = path.join(tempDir, "artifact");

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Storage] Downloaded VAS artifact (${snapshot.artifactName}) version ${versionId}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      preparedArtifact: {
        driver: "vas",
        localPath,
        mountPath,
        vasStorageName: snapshot.artifactName,
        vasVersionId: versionId,
      },
      tempDir,
      errors: [],
    };
  }

  /**
   * Mount storages and artifact: upload prepared storages from local temp to sandbox
   * @param sandbox - E2B sandbox instance
   * @param preparedStorages - Storages that have been downloaded to local temp
   * @param preparedArtifact - Artifact that has been prepared (optional)
   */
  async mountStorages(
    sandbox: Sandbox,
    preparedStorages: PreparedStorage[],
    preparedArtifact?: PreparedArtifact | null,
  ): Promise<void> {
    const totalMounts = preparedStorages.length + (preparedArtifact ? 1 : 0);

    if (totalMounts === 0) {
      return;
    }

    console.log(`[Storage] Mounting ${totalMounts} items to sandbox...`);

    // Mount storages
    for (const storage of preparedStorages) {
      try {
        // VAS storages: upload from local temp to sandbox
        const stat = await fs.promises
          .stat(storage.localPath!)
          .catch(() => null);
        if (stat) {
          await this.uploadDirectoryToSandbox(
            sandbox,
            storage.localPath!,
            storage.mountPath,
          );
          console.log(
            `[Storage] Uploaded VAS storage "${storage.name}" to ${storage.mountPath}`,
          );
        }
      } catch (error) {
        console.error(
          `[Storage] Failed to mount storage "${storage.name}":`,
          error,
        );
        throw error;
      }
    }

    // Mount artifact
    if (preparedArtifact) {
      try {
        // VAS artifact: upload from local temp to sandbox
        const stat = await fs.promises
          .stat(preparedArtifact.localPath!)
          .catch(() => null);
        if (stat) {
          await this.uploadDirectoryToSandbox(
            sandbox,
            preparedArtifact.localPath!,
            preparedArtifact.mountPath,
          );
          console.log(
            `[Storage] Uploaded VAS artifact to ${preparedArtifact.mountPath}`,
          );
        }
      } catch (error) {
        console.error(`[Storage] Failed to mount artifact:`, error);
        throw error;
      }
    }
  }

  /**
   * Upload directory contents to E2B sandbox recursively
   * @param sandbox - E2B sandbox instance
   * @param localDir - Local directory path
   * @param remotePath - Remote path in sandbox
   */
  private async uploadDirectoryToSandbox(
    sandbox: Sandbox,
    localDir: string,
    remotePath: string,
  ): Promise<void> {
    const entries = await fs.promises.readdir(localDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const remoteFilePath = path.posix.join(remotePath, entry.name);

      if (entry.isDirectory()) {
        await this.uploadDirectoryToSandbox(sandbox, localPath, remoteFilePath);
      } else {
        const content = await fs.promises.readFile(localPath);
        // Convert Buffer to ArrayBuffer for E2B
        const arrayBuffer = content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ) as ArrayBuffer;
        await sandbox.files.write(remoteFilePath, arrayBuffer);
      }
    }
  }

  /**
   * Cleanup: remove temporary directory
   * @param tempDir - Temporary directory path to remove
   */
  async cleanup(tempDir: string | null): Promise<void> {
    if (!tempDir) {
      return;
    }

    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      console.log(`[Storage] Cleaned up temp directory: ${tempDir}`);
    } catch (error) {
      console.error(`[Storage] Failed to cleanup temp directory:`, error);
    }
  }
}

// Export singleton instance
export const storageService = new StorageService();
