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
   * Prepare storages: resolve configurations and download from S3 to temp directory
   * @param agentConfig - Agent configuration containing volume definitions
   * @param dynamicVars - Dynamic variables for template replacement
   * @param runId - Run ID for temp directory naming
   * @param userId - User ID for storage access (optional)
   * @param artifactKey - Artifact key for VAS driver (optional)
   * @returns Storage preparation result with prepared storages and temp directory
   */
  async prepareStorages(
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
    runId: string,
    userId?: string,
    artifactKey?: string,
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
      dynamicVars,
      artifactKey,
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

    // Process each volume (VAS only)
    for (const volume of volumeResult.volumes) {
      try {
        if (!userId) {
          throw new Error("userId is required for VAS storages");
        }

        // Query database for storage and HEAD version
        const [dbStorage] = await globalThis.services.db
          .select()
          .from(storages)
          .where(
            and(
              eq(storages.userId, userId),
              eq(storages.name, volume.vasStorageName!),
            ),
          )
          .limit(1);

        if (!dbStorage) {
          throw new Error(
            `VAS storage "${volume.vasStorageName}" not found in database`,
          );
        }

        if (!dbStorage.headVersionId) {
          throw new Error(
            `VAS storage "${volume.vasStorageName}" has no HEAD version`,
          );
        }

        // Get HEAD version details
        const [headVersion] = await globalThis.services.db
          .select()
          .from(storageVersions)
          .where(eq(storageVersions.id, dbStorage.headVersionId))
          .limit(1);

        if (!headVersion) {
          throw new Error(
            `VAS storage "${volume.vasStorageName}" HEAD version not found`,
          );
        }

        // Download from versioned S3 path
        const bucketName = env().S3_USER_STORAGES_NAME;
        if (!bucketName) {
          throw new Error(
            "S3_USER_STORAGES_NAME environment variable is not set",
          );
        }
        const s3Uri = `s3://${bucketName}/${headVersion.s3Key}`;
        const localPath = path.join(tempDir!, volume.name);

        const downloadResult = await downloadS3Directory(s3Uri, localPath);
        console.log(
          `[Storage] Downloaded VAS storage "${volume.name}" (${volume.vasStorageName}) version ${headVersion.id}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
        );

        preparedStorages.push({
          name: volume.name,
          driver: "vas",
          localPath,
          mountPath: volume.mountPath,
          vasStorageName: volume.vasStorageName,
          vasVersionId: headVersion.id,
        });
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
          tempDir,
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
   * Prepare a single artifact
   */
  private async prepareArtifact(
    artifact: ResolvedArtifact,
    tempDir: string | null,
    userId?: string,
  ): Promise<PreparedArtifact> {
    // VAS artifact: download from S3
    if (!userId) {
      throw new Error("userId is required for VAS artifacts");
    }

    if (!tempDir) {
      throw new Error("tempDir is required for VAS artifacts");
    }

    // Query database for artifact storage and HEAD version
    const [dbStorage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.userId, userId),
          eq(storages.name, artifact.vasStorageName!),
        ),
      )
      .limit(1);

    if (!dbStorage) {
      throw new Error(
        `VAS artifact "${artifact.vasStorageName}" not found in database`,
      );
    }

    if (!dbStorage.headVersionId) {
      throw new Error(
        `VAS artifact "${artifact.vasStorageName}" has no HEAD version`,
      );
    }

    // Get HEAD version details
    const [headVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, dbStorage.headVersionId))
      .limit(1);

    if (!headVersion) {
      throw new Error(
        `VAS artifact "${artifact.vasStorageName}" HEAD version not found`,
      );
    }

    // Download from versioned S3 path
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      throw new Error("S3_USER_STORAGES_NAME environment variable is not set");
    }
    const s3Uri = `s3://${bucketName}/${headVersion.s3Key}`;
    const localPath = path.join(tempDir, "artifact");

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Storage] Downloaded VAS artifact (${artifact.vasStorageName}) version ${headVersion.id}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      driver: "vas",
      localPath,
      mountPath: artifact.mountPath,
      vasStorageName: artifact.vasStorageName,
      vasVersionId: headVersion.id,
    };
  }

  /**
   * Prepare artifact from checkpoint snapshot (for resume functionality)
   * @param snapshot - Artifact snapshot from checkpoint
   * @param runId - Run ID for temp directory naming
   * @returns Prepared artifact
   */
  async prepareArtifactFromSnapshot(
    snapshot: ArtifactSnapshot,
    _agentConfig: AgentVolumeConfig | undefined,
    _dynamicVars: Record<string, string>,
    runId: string,
  ): Promise<{
    preparedArtifact: PreparedArtifact | null;
    tempDir: string | null;
    errors: string[];
  }> {
    console.log(`[Storage] Preparing artifact from snapshot...`);

    // VAS artifact: download from specific version
    if (!snapshot.snapshot?.versionId) {
      return {
        preparedArtifact: null,
        tempDir: null,
        errors: ["VAS snapshot missing versionId"],
      };
    }

    const tempDir = `/tmp/vas-run-${runId}`;
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Get the version from database to get S3 key
    const [version] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, snapshot.snapshot.versionId))
      .limit(1);

    if (!version) {
      return {
        preparedArtifact: null,
        tempDir,
        errors: [
          `VAS artifact version "${snapshot.snapshot.versionId}" not found`,
        ],
      };
    }

    // Download from the specific version's S3 path
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      return {
        preparedArtifact: null,
        tempDir,
        errors: ["S3_USER_STORAGES_NAME environment variable is not set"],
      };
    }
    const s3Uri = `s3://${bucketName}/${version.s3Key}`;
    const localPath = path.join(tempDir, "artifact");

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Storage] Downloaded VAS artifact (${snapshot.vasStorageName}) version ${snapshot.snapshot.versionId}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      preparedArtifact: {
        driver: "vas",
        localPath,
        mountPath: snapshot.mountPath,
        vasStorageName: snapshot.vasStorageName,
        vasVersionId: snapshot.snapshot.versionId,
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
