import type { Sandbox } from "@e2b/code-interpreter";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveVolumes } from "./volume-resolver";
import { downloadS3Directory } from "../s3/s3-client";
import type {
  AgentVolumeConfig,
  PreparedVolume,
  VolumePreparationResult,
} from "./types";

/**
 * Volume Service
 * Manages volume preparation, mounting, and cleanup operations
 */
export class VolumeService {
  /**
   * Prepare volumes: resolve configurations and download from S3 to temp directory
   * @param agentConfig - Agent configuration containing volume definitions
   * @param dynamicVars - Dynamic variables for template replacement
   * @param runId - Run ID for temp directory naming
   * @returns Volume preparation result with prepared volumes and temp directory
   */
  async prepareVolumes(
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
    runId: string,
  ): Promise<VolumePreparationResult> {
    const errors: string[] = [];

    // If no agent config, return empty result
    if (!agentConfig) {
      return {
        preparedVolumes: [],
        tempDir: null,
        errors: [],
      };
    }

    // Resolve volumes from agent config
    const volumeResult = resolveVolumes(agentConfig, dynamicVars);

    // Log volume resolution errors but don't fail the preparation
    if (volumeResult.errors.length > 0) {
      console.warn(`[Volume] Volume resolution errors:`, volumeResult.errors);
      errors.push(
        ...volumeResult.errors.map((e) => `${e.volumeName}: ${e.message}`),
      );
    }

    // If no volumes to prepare, return empty result
    if (volumeResult.volumes.length === 0) {
      return {
        preparedVolumes: [],
        tempDir: null,
        errors,
      };
    }

    // Create temp directory for volume downloads
    const tempDir = `/tmp/vm0-run-${runId}`;
    await fs.promises.mkdir(tempDir, { recursive: true });

    console.log(
      `[Volume] Downloading ${volumeResult.volumes.length} volumes...`,
    );

    const preparedVolumes: PreparedVolume[] = [];

    // Download each volume from S3
    for (const volume of volumeResult.volumes) {
      try {
        const localPath = path.join(tempDir, volume.name);
        const downloadResult = await downloadS3Directory(
          volume.s3Uri,
          localPath,
        );
        console.log(
          `[Volume] Downloaded volume "${volume.name}": ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
        );

        preparedVolumes.push({
          name: volume.name,
          localPath,
          mountPath: volume.mountPath,
          s3Uri: volume.s3Uri,
        });
      } catch (error) {
        console.error(
          `[Volume] Failed to download volume "${volume.name}":`,
          error,
        );
        errors.push(
          `${volume.name}: Failed to download - ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    return {
      preparedVolumes,
      tempDir,
      errors,
    };
  }

  /**
   * Mount volumes: upload prepared volumes from local temp to sandbox
   * @param sandbox - E2B sandbox instance
   * @param preparedVolumes - Volumes that have been downloaded to local temp
   */
  async mountVolumes(
    sandbox: Sandbox,
    preparedVolumes: PreparedVolume[],
  ): Promise<void> {
    if (preparedVolumes.length === 0) {
      return;
    }

    console.log(
      `[Volume] Uploading ${preparedVolumes.length} volumes to sandbox...`,
    );

    for (const volume of preparedVolumes) {
      try {
        // Check if directory exists before uploading
        const stat = await fs.promises.stat(volume.localPath).catch(() => null);
        if (stat) {
          await this.uploadDirectoryToSandbox(
            sandbox,
            volume.localPath,
            volume.mountPath,
          );
          console.log(
            `[Volume] Uploaded volume "${volume.name}" to ${volume.mountPath}`,
          );
        }
      } catch (error) {
        console.error(
          `[Volume] Failed to upload volume "${volume.name}":`,
          error,
        );
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
      console.log(`[Volume] Cleaned up temp directory: ${tempDir}`);
    } catch (error) {
      console.error(`[Volume] Failed to cleanup temp directory:`, error);
    }
  }
}

// Export singleton instance
export const volumeService = new VolumeService();
