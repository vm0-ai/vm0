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
  PreparedArtifact,
  VolumePreparationResult,
  ResolvedArtifact,
} from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
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
   * @param artifactKey - Artifact key for VM0 driver (optional)
   * @returns Volume preparation result with prepared volumes and temp directory
   */
  async prepareVolumes(
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
    runId: string,
    userId?: string,
    artifactKey?: string,
  ): Promise<VolumePreparationResult> {
    const errors: string[] = [];

    // If no agent config, return empty result
    if (!agentConfig) {
      return {
        preparedVolumes: [],
        preparedArtifact: null,
        tempDir: null,
        errors: [],
      };
    }

    // Resolve volumes from agent config
    const volumeResult = resolveVolumes(agentConfig, dynamicVars, artifactKey);

    // Log volume resolution errors but don't fail the preparation
    if (volumeResult.errors.length > 0) {
      console.warn(`[Volume] Volume resolution errors:`, volumeResult.errors);
      errors.push(
        ...volumeResult.errors.map((e) => `${e.volumeName}: ${e.message}`),
      );
    }

    // Check if we need a temp directory (for VM0 volumes/artifacts)
    const hasVm0Volumes = volumeResult.volumes.length > 0;
    const hasVm0Artifact =
      volumeResult.artifact && volumeResult.artifact.driver === "vm0";
    const needsTempDir = hasVm0Volumes || hasVm0Artifact;

    let tempDir: string | null = null;
    if (needsTempDir) {
      tempDir = `/tmp/vm0-run-${runId}`;
      await fs.promises.mkdir(tempDir, { recursive: true });
    }

    console.log(
      `[Volume] Preparing ${volumeResult.volumes.length} volumes and ${volumeResult.artifact ? "1 artifact" : "no artifact"}...`,
    );

    const preparedVolumes: PreparedVolume[] = [];
    let preparedArtifact: PreparedArtifact | null = null;

    // Process each volume (VM0 only)
    for (const volume of volumeResult.volumes) {
      try {
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
        const localPath = path.join(tempDir!, volume.name);

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
        });
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

    // Process artifact
    if (volumeResult.artifact) {
      try {
        preparedArtifact = await this.prepareArtifact(
          volumeResult.artifact,
          tempDir,
          userId,
        );
      } catch (error) {
        console.error(`[Volume] Failed to prepare artifact:`, error);
        errors.push(
          `artifact: Failed to prepare - ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }

    return {
      preparedVolumes,
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
    if (artifact.driver === "git") {
      // Git artifact: store metadata only (clone happens in sandbox)
      console.log(
        `[Volume] Prepared Git artifact: ${sanitizeGitUrlForLogging(artifact.gitUri!)} (${artifact.gitBranch})`,
      );

      return {
        driver: "git",
        mountPath: artifact.mountPath,
        gitUri: artifact.gitUri,
        gitBranch: artifact.gitBranch,
        gitToken: artifact.gitToken,
      };
    }

    // VM0 artifact: download from S3
    if (!userId) {
      throw new Error("userId is required for VM0 artifacts");
    }

    if (!tempDir) {
      throw new Error("tempDir is required for VM0 artifacts");
    }

    // Query database for artifact volume and HEAD version
    const [dbVolume] = await globalThis.services.db
      .select()
      .from(volumes)
      .where(
        and(
          eq(volumes.userId, userId),
          eq(volumes.name, artifact.vm0VolumeName!),
        ),
      )
      .limit(1);

    if (!dbVolume) {
      throw new Error(
        `VM0 artifact "${artifact.vm0VolumeName}" not found in database`,
      );
    }

    if (!dbVolume.headVersionId) {
      throw new Error(
        `VM0 artifact "${artifact.vm0VolumeName}" has no HEAD version`,
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
        `VM0 artifact "${artifact.vm0VolumeName}" HEAD version not found`,
      );
    }

    // Download from versioned S3 path
    const s3Uri = `s3://vm0-s3-user-volumes/${headVersion.s3Key}`;
    const localPath = path.join(tempDir, "artifact");

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Volume] Downloaded VM0 artifact (${artifact.vm0VolumeName}) version ${headVersion.id}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      driver: "vm0",
      localPath,
      mountPath: artifact.mountPath,
      vm0VolumeName: artifact.vm0VolumeName,
      vm0VersionId: headVersion.id,
    };
  }

  /**
   * Prepare artifact from checkpoint snapshot (for resume functionality)
   * @param snapshot - Artifact snapshot from checkpoint
   * @param agentConfig - Agent configuration containing artifact definition
   * @param dynamicVars - Dynamic variables for template replacement
   * @param runId - Run ID for temp directory naming
   * @returns Prepared artifact
   */
  async prepareArtifactFromSnapshot(
    snapshot: ArtifactSnapshot,
    agentConfig: AgentVolumeConfig | undefined,
    dynamicVars: Record<string, string>,
    runId: string,
  ): Promise<{ preparedArtifact: PreparedArtifact | null; tempDir: string | null; errors: string[] }> {
    const errors: string[] = [];

    if (!agentConfig?.agent?.artifact) {
      return {
        preparedArtifact: null,
        tempDir: null,
        errors: ["Agent config missing artifact definition"],
      };
    }

    console.log(
      `[Volume] Preparing artifact from snapshot (driver: ${snapshot.driver})...`,
    );

    if (snapshot.driver === "git") {
      // Git artifact: resolve from config but use snapshot branch
      if (!snapshot.snapshot?.branch) {
        return {
          preparedArtifact: null,
          tempDir: null,
          errors: ["Git snapshot missing branch"],
        };
      }

      // Resolve artifact config to get URI and token
      const volumeResult = resolveVolumes(agentConfig, dynamicVars);
      if (!volumeResult.artifact || volumeResult.artifact.driver !== "git") {
        return {
          preparedArtifact: null,
          tempDir: null,
          errors: ["Agent config artifact is not a git artifact"],
        };
      }

      console.log(
        `[Volume] Prepared Git artifact from snapshot: branch ${snapshot.snapshot.branch}, commit ${snapshot.snapshot.commitId}`,
      );

      return {
        preparedArtifact: {
          driver: "git",
          mountPath: snapshot.mountPath,
          gitUri: volumeResult.artifact.gitUri,
          gitBranch: snapshot.snapshot.branch,
          gitToken: volumeResult.artifact.gitToken,
        },
        tempDir: null,
        errors: [],
      };
    }

    // VM0 artifact: download from specific version
    if (!snapshot.snapshot?.versionId) {
      return {
        preparedArtifact: null,
        tempDir: null,
        errors: ["VM0 snapshot missing versionId"],
      };
    }

    const tempDir = `/tmp/vm0-run-${runId}`;
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Get the version from database to get S3 key
    const [version] = await globalThis.services.db
      .select()
      .from(volumeVersions)
      .where(eq(volumeVersions.id, snapshot.snapshot.versionId))
      .limit(1);

    if (!version) {
      return {
        preparedArtifact: null,
        tempDir,
        errors: [`VM0 artifact version "${snapshot.snapshot.versionId}" not found`],
      };
    }

    // Download from the specific version's S3 path
    const s3Uri = `s3://vm0-s3-user-volumes/${version.s3Key}`;
    const localPath = path.join(tempDir, "artifact");

    const downloadResult = await downloadS3Directory(s3Uri, localPath);
    console.log(
      `[Volume] Downloaded VM0 artifact (${snapshot.vm0VolumeName}) version ${snapshot.snapshot.versionId}: ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
    );

    return {
      preparedArtifact: {
        driver: "vm0",
        localPath,
        mountPath: snapshot.mountPath,
        vm0VolumeName: snapshot.vm0VolumeName,
        vm0VersionId: snapshot.snapshot.versionId,
      },
      tempDir,
      errors: [],
    };
  }

  /**
   * Mount volumes and artifact: upload prepared volumes from local temp to sandbox
   * @param sandbox - E2B sandbox instance
   * @param preparedVolumes - Volumes that have been downloaded to local temp
   * @param preparedArtifact - Artifact that has been prepared (optional)
   */
  async mountVolumes(
    sandbox: Sandbox,
    preparedVolumes: PreparedVolume[],
    preparedArtifact?: PreparedArtifact | null,
  ): Promise<void> {
    const totalMounts =
      preparedVolumes.length + (preparedArtifact ? 1 : 0);

    if (totalMounts === 0) {
      return;
    }

    console.log(`[Volume] Mounting ${totalMounts} items to sandbox...`);

    // Mount volumes
    for (const volume of preparedVolumes) {
      try {
        // VM0 volumes: upload from local temp to sandbox
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
      } catch (error) {
        console.error(
          `[Volume] Failed to mount volume "${volume.name}":`,
          error,
        );
        throw error;
      }
    }

    // Mount artifact
    if (preparedArtifact) {
      try {
        if (preparedArtifact.driver === "vm0") {
          // VM0 artifact: upload from local temp to sandbox
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
              `[Volume] Uploaded VM0 artifact to ${preparedArtifact.mountPath}`,
            );
          }
        } else if (preparedArtifact.driver === "git") {
          // Git artifact: clone directly in sandbox
          await this.cloneGitRepo(
            sandbox,
            preparedArtifact.gitUri!,
            preparedArtifact.gitBranch!,
            preparedArtifact.mountPath,
            preparedArtifact.gitToken,
          );
          console.log(
            `[Volume] Cloned Git artifact to ${preparedArtifact.mountPath}`,
          );
        }
      } catch (error) {
        console.error(`[Volume] Failed to mount artifact:`, error);
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
