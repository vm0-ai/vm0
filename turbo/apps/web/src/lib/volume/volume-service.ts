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
import type {
  VolumeSnapshot,
  Vm0VolumeSnapshot,
  GitVolumeSnapshot,
} from "../checkpoint/types";
import { volumes, volumeVersions } from "../../db/schema/volume";
import { eq, and } from "drizzle-orm";

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
        if (volume.driver === "git") {
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
            isDynamic: volume.isDynamic,
          });
        } else if (volume.driver === "vm0") {
          // VM0 volumes: download from S3 using HEAD version
          if (!userId) {
            throw new Error("userId is required for VM0 volumes");
          }

          // Query database for volume and HEAD version
          const [dbVolume] = await globalThis.services.db
            .select()
            .from(volumes)
            .where(
              and(
                eq(volumes.userId, userId),
                eq(volumes.name, volume.vm0VolumeName!),
              ),
            )
            .limit(1);

          if (!dbVolume) {
            throw new Error(
              `VM0 volume "${volume.vm0VolumeName}" not found in database`,
            );
          }

          if (!dbVolume.headVersionId) {
            throw new Error(
              `VM0 volume "${volume.vm0VolumeName}" has no HEAD version`,
            );
          }

          // Get HEAD version details
          const [headVersion] = await globalThis.services.db
            .select()
            .from(volumeVersions)
            .where(eq(volumeVersions.id, dbVolume.headVersionId))
            .limit(1);

          if (!headVersion) {
            throw new Error(
              `VM0 volume "${volume.vm0VolumeName}" HEAD version not found`,
            );
          }

          // Download from versioned S3 path
          const s3Uri = `s3://vm0-s3-user-volumes/${headVersion.s3Key}`;
          const localPath = path.join(tempDir, volume.name);

          const downloadResult = await downloadS3Directory(s3Uri, localPath);
          console.log(
            `[Volume] Downloaded VM0 volume "${volume.name}" (${volume.vm0VolumeName}) version ${headVersion.id}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
          );

          preparedVolumes.push({
            name: volume.name,
            driver: "vm0",
            localPath,
            mountPath: volume.mountPath,
            vm0VolumeName: volume.vm0VolumeName,
            vm0VersionId: headVersion.id,
            isDynamic: volume.isDynamic,
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
   * For VM0 volumes, downloads from the specific version stored in checkpoint
   * @param snapshots - Volume snapshots from checkpoint
   * @param agentConfig - Agent configuration containing volume definitions
   * @param dynamicVars - Dynamic variables for template replacement
   * @param runId - Run ID for temp directory naming (required for VM0 volumes)
   * @returns Volume preparation result with prepared volumes
   */
  async prepareVolumesFromSnapshots(
    snapshots: VolumeSnapshot[],
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
    runId?: string,
  ): Promise<VolumePreparationResult> {
    const errors: string[] = [];

    console.log(
      `[Volume] Preparing ${snapshots.length} volumes from snapshots...`,
    );
    console.log(`[Volume] Snapshots data:`, JSON.stringify(snapshots, null, 2));

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

    console.log(
      `[Volume] Resolved ${resolvedVolumeMap.size} volumes from agent config`,
    );

    // Check if we have VM0 snapshots that need a temp directory
    const hasVm0Snapshots = snapshots.some((s) => s.driver === "vm0");
    let tempDir: string | null = null;

    if (hasVm0Snapshots && runId) {
      tempDir = `/tmp/vm0-run-${runId}`;
      await fs.promises.mkdir(tempDir, { recursive: true });
    }

    // Process each snapshot
    for (const snapshot of snapshots) {
      try {
        console.log(
          `[Volume] Processing snapshot "${snapshot.name}" (driver: ${snapshot.driver})`,
        );

        if (snapshot.driver === "git") {
          const gitSnapshot = snapshot as GitVolumeSnapshot;
          // Debug logging for snapshot structure
          console.log(
            `[Volume] Snapshot.snapshot exists: ${!!gitSnapshot.snapshot}`,
          );
          console.log(
            `[Volume] Snapshot.snapshot value:`,
            JSON.stringify(gitSnapshot.snapshot, null, 2),
          );

          if (!gitSnapshot.snapshot) {
            throw new Error("Git snapshot missing snapshot data");
          }

          if (!gitSnapshot.snapshot.branch) {
            throw new Error(
              `Git snapshot missing branch name. Snapshot: ${JSON.stringify(gitSnapshot.snapshot)}`,
            );
          }

          // Get the resolved volume from agent config
          const resolvedVolume = resolvedVolumeMap.get(snapshot.name);
          if (!resolvedVolume) {
            throw new Error(
              `Volume "${snapshot.name}" not found in agent config`,
            );
          }

          console.log(
            `[Volume] Resolved volume "${snapshot.name}": ${sanitizeGitUrlForLogging(resolvedVolume.gitUri!)}`,
          );

          console.log(
            `[Volume] Prepared Git snapshot "${snapshot.name}": branch ${gitSnapshot.snapshot.branch}, commit ${gitSnapshot.snapshot.commitId}`,
          );

          // Use snapshot branch instead of default branch
          // Volumes from snapshots are always dynamic (only dynamic volumes create checkpoints)
          const preparedVolume: PreparedVolume = {
            name: snapshot.name,
            driver: "git",
            mountPath: snapshot.mountPath,
            gitUri: resolvedVolume.gitUri,
            gitBranch: gitSnapshot.snapshot.branch, // Use snapshot branch
            gitToken: resolvedVolume.gitToken,
            isDynamic: true,
          };

          console.log(
            `[Volume] Prepared volume "${snapshot.name}" with branch: ${preparedVolume.gitBranch}`,
          );

          preparedVolumes.push(preparedVolume);
        } else if (snapshot.driver === "vm0") {
          const vm0Snapshot = snapshot as Vm0VolumeSnapshot;

          if (!vm0Snapshot.snapshot?.versionId) {
            throw new Error("VM0 snapshot missing versionId");
          }

          if (!tempDir) {
            throw new Error("runId is required for VM0 volume restoration");
          }

          // Get the version from database to get S3 key
          const [version] = await globalThis.services.db
            .select()
            .from(volumeVersions)
            .where(eq(volumeVersions.id, vm0Snapshot.snapshot.versionId))
            .limit(1);

          if (!version) {
            throw new Error(
              `VM0 volume version "${vm0Snapshot.snapshot.versionId}" not found`,
            );
          }

          // Download from the specific version's S3 path
          const s3Uri = `s3://vm0-s3-user-volumes/${version.s3Key}`;
          const localPath = path.join(tempDir, snapshot.name);

          const downloadResult = await downloadS3Directory(s3Uri, localPath);
          console.log(
            `[Volume] Downloaded VM0 volume "${snapshot.name}" (${vm0Snapshot.vm0VolumeName}) version ${vm0Snapshot.snapshot.versionId}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
          );

          // Volumes from snapshots are always dynamic (only dynamic volumes create checkpoints)
          preparedVolumes.push({
            name: snapshot.name,
            driver: "vm0",
            localPath,
            mountPath: snapshot.mountPath,
            vm0VolumeName: vm0Snapshot.vm0VolumeName,
            vm0VersionId: vm0Snapshot.snapshot.versionId,
            isDynamic: true,
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

    console.log(
      `[Volume] Prepared ${preparedVolumes.length} volumes from snapshots`,
    );

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
      `[Volume] Mounting ${preparedVolumes.length} volumes to sandbox...`,
    );

    for (const volume of preparedVolumes) {
      try {
        if (volume.driver === "vm0") {
          // Upload VM0 volumes from local temp to sandbox
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
              `[Volume] Uploaded VM0 volume "${volume.name}" to ${volume.mountPath}`,
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
      `[Volume] Cloning Git repo: ${sanitizeGitUrlForLogging(gitUri)} (branch: ${branch}) to ${mountPath}`,
    );

    // Execute git clone in sandbox
    const result = await sandbox.commands.run(cloneCommand);

    // Check for errors
    if (result.exitCode !== 0) {
      const errorMessage = result.stderr || result.stdout || "Unknown error";
      console.error(
        `[Volume] Git clone failed with exit code ${result.exitCode}`,
      );
      console.error(
        `[Volume] Command: git clone --single-branch --branch "${branch}" [url] "${mountPath}"`,
      );
      console.error(`[Volume] stderr:`, result.stderr);
      console.error(`[Volume] stdout:`, result.stdout);

      throw new Error(
        `Git clone failed (exit ${result.exitCode}): Branch "${branch}" - ${errorMessage}`,
      );
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
