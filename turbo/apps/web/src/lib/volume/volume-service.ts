import type { Sandbox } from "@e2b/code-interpreter";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveVolumes } from "./volume-resolver";
import { downloadS3Directory } from "../s3/s3-client";
import {
  buildAuthenticatedUrl,
  buildGitCloneCommand,
  sanitizeGitUrlForLogging,
} from "../git/git-client";
import type {
  AgentVolumeConfig,
  PreparedVolume,
  VolumePreparationResult,
} from "./types";
import type { VolumeSnapshot } from "../checkpoint/types";

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
   * @param userId - User ID for VM0 volume access (optional)
   * @returns Volume preparation result with prepared volumes and temp directory
   */
  async prepareVolumes(
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
    runId: string,
    userId?: string,
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

    // Process each volume based on driver type
    for (const volume of volumeResult.volumes) {
      try {
        if (volume.driver === "s3fs") {
          // Download S3 volumes to temp directory
          const localPath = path.join(tempDir, volume.name);
          const downloadResult = await downloadS3Directory(
            volume.s3Uri!,
            localPath,
          );
          console.log(
            `[Volume] Downloaded S3 volume "${volume.name}": ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
          );

          preparedVolumes.push({
            name: volume.name,
            driver: "s3fs",
            localPath,
            mountPath: volume.mountPath,
            s3Uri: volume.s3Uri,
          });
        } else if (volume.driver === "git") {
          // Git volumes: store metadata only (clone happens in sandbox)
          console.log(
            `[Volume] Prepared Git volume "${volume.name}": ${sanitizeGitUrlForLogging(volume.gitUri!)} (${volume.gitBranch})`,
          );

          preparedVolumes.push({
            name: volume.name,
            driver: "git",
            mountPath: volume.mountPath,
            gitUri: volume.gitUri,
            gitBranch: volume.gitBranch,
            gitToken: volume.gitToken,
          });
        } else if (volume.driver === "vm0") {
          // VM0 volumes: download from S3 using user-specific prefix
          if (!userId) {
            throw new Error("userId is required for VM0 volumes");
          }

          const s3Prefix = `${userId}/${volume.vm0VolumeName}`;
          const s3Uri = `s3://vm0-s3-user-volumes/${s3Prefix}`;
          const localPath = path.join(tempDir, volume.name);

          const downloadResult = await downloadS3Directory(s3Uri, localPath);
          console.log(
            `[Volume] Downloaded VM0 volume "${volume.name}" (${volume.vm0VolumeName}): ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
          );

          preparedVolumes.push({
            name: volume.name,
            driver: "vm0",
            localPath,
            mountPath: volume.mountPath,
          });
        }
      } catch (error) {
        console.error(
          `[Volume] Failed to prepare volume "${volume.name}":`,
          error,
        );
        errors.push(
          `${volume.name}: Failed to prepare - ${error instanceof Error ? error.message : "Unknown error"}`,
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
   * Prepare volumes from checkpoint snapshots (for resume functionality)
   * Resolves Git URI and token from agent config and uses snapshot branch
   * @param snapshots - Volume snapshots from checkpoint
   * @param agentConfig - Agent configuration containing volume definitions
   * @param dynamicVars - Dynamic variables for template replacement
   * @returns Volume preparation result with prepared volumes
   */
  async prepareVolumesFromSnapshots(
    snapshots: VolumeSnapshot[],
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
  ): Promise<VolumePreparationResult> {
    const errors: string[] = [];

    console.log(
      `[Volume] Preparing ${snapshots.length} volumes from snapshots...`,
    );

    if (!agentConfig) {
      return {
        preparedVolumes: [],
        tempDir: null,
        errors: ["Agent config not provided"],
      };
    }

    const preparedVolumes: PreparedVolume[] = [];

    // First resolve volumes from agent config to get URI and token
    const volumeResult = resolveVolumes(agentConfig, dynamicVars);
    const resolvedVolumeMap = new Map(
      volumeResult.volumes.map((v) => [v.name, v]),
    );

    // Process each snapshot
    for (const snapshot of snapshots) {
      try {
        if (snapshot.driver === "git") {
          if (!snapshot.snapshot) {
            throw new Error("Git snapshot missing snapshot data");
          }

          // Get the resolved volume from agent config
          const resolvedVolume = resolvedVolumeMap.get(snapshot.name);
          if (!resolvedVolume) {
            throw new Error(
              `Volume "${snapshot.name}" not found in agent config`,
            );
          }

          console.log(
            `[Volume] Prepared Git snapshot "${snapshot.name}": branch ${snapshot.snapshot.branch}, commit ${snapshot.snapshot.commitId}`,
          );

          // Use snapshot branch instead of default branch
          preparedVolumes.push({
            name: snapshot.name,
            driver: "git",
            mountPath: snapshot.mountPath,
            gitUri: resolvedVolume.gitUri,
            gitBranch: snapshot.snapshot.branch, // Use snapshot branch
            gitToken: resolvedVolume.gitToken,
          });
        }
      } catch (error) {
        console.error(
          `[Volume] Failed to prepare snapshot "${snapshot.name}":`,
          error,
        );
        errors.push(
          `${snapshot.name}: Failed to prepare snapshot - ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    return {
      preparedVolumes,
      tempDir: null,
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
      `[Volume] Mounting ${preparedVolumes.length} volumes to sandbox...`,
    );

    for (const volume of preparedVolumes) {
      try {
        if (volume.driver === "s3fs" || volume.driver === "vm0") {
          // Upload S3 or VM0 volumes from local temp to sandbox
          const stat = await fs.promises
            .stat(volume.localPath!)
            .catch(() => null);
          if (stat) {
            await this.uploadDirectoryToSandbox(
              sandbox,
              volume.localPath!,
              volume.mountPath,
            );
            console.log(
              `[Volume] Uploaded ${volume.driver} volume "${volume.name}" to ${volume.mountPath}`,
            );
          }
        } else if (volume.driver === "git") {
          // Clone Git repository directly in sandbox
          await this.cloneGitRepo(
            sandbox,
            volume.gitUri!,
            volume.gitBranch!,
            volume.mountPath,
            volume.gitToken,
          );
          console.log(
            `[Volume] Cloned Git volume "${volume.name}" to ${volume.mountPath}`,
          );
        }
      } catch (error) {
        console.error(
          `[Volume] Failed to mount volume "${volume.name}":`,
          error,
        );
        throw error;
      }
    }
  }

  /**
   * Clone Git repository directly in E2B sandbox
   * @param sandbox - E2B sandbox instance
   * @param gitUri - Git repository URL
   * @param branch - Branch to clone
   * @param mountPath - Target directory path
   * @param token - Authentication token (optional)
   */
  private async cloneGitRepo(
    sandbox: Sandbox,
    gitUri: string,
    branch: string,
    mountPath: string,
    token?: string,
  ): Promise<void> {
    // Build authenticated URL if token provided
    const authUrl = buildAuthenticatedUrl(gitUri, token);

    // Build clone command
    const cloneCommand = buildGitCloneCommand(authUrl, branch, mountPath);

    // Log sanitized command
    console.log(
      `[Volume] Cloning Git repo: ${sanitizeGitUrlForLogging(gitUri)} (branch: ${branch})`,
    );

    // Execute git clone in sandbox
    const result = await sandbox.commands.run(cloneCommand);

    // Check for errors
    if (result.exitCode !== 0) {
      const errorMessage = result.stderr || result.stdout || "Unknown error";
      throw new Error(`Git clone failed: ${errorMessage}`);
    }

    console.log(`[Volume] Git clone successful: ${mountPath}`);
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
